import { Node } from 'broccoli-node-api';
import Plugin from 'broccoli-plugin';
import walkSync from 'walk-sync';
import { unlinkSync, rmdirSync, mkdirSync, readFileSync, removeSync } from 'fs-extra';
import FSTree from 'fs-tree-diff';
import makeDebug from 'debug';
import { join, extname } from 'path';
import { isEqual, flatten } from 'lodash';
import type Package from './package';
import symlinkOrCopy from 'symlink-or-copy';
import { TransformOptions } from '@babel/core';
import { CallExpression, Expression, File, TSType } from '@babel/types';
import type { Program } from '@swc/core/types';
import traverse from '@babel/traverse';
import {
  transformSync as swcTransfromSync,
  Expression as SwcExpression,
  ImportDeclaration as SwcImportDeclaration,
  ExportNamedDeclaration as SwcExportNamedDeclaration,
  CallExpression as SwcCallExpression,
  TemplateElement as SwcTemplateElement,
} from '@swc/core';
import type { ParseOptions } from '@swc/core/types';
import Visitor from '@swc/core/Visitor';

makeDebug.formatters.m = (modules: Import[]) => {
  return JSON.stringify(
    modules.map(m => {
      if ('specifier' in m) {
        return {
          specifier: m.specifier,
          path: m.path,
          isDynamic: m.isDynamic,
          package: m.package.name,
          treeType: m.treeType,
        };
      } else {
        return {
          cookedQuasis: m.cookedQuasis,
          expressionNameHints: m.expressionNameHints,
          path: m.path,
          isDynamic: m.isDynamic,
          package: m.package.name,
          treeType: m.treeType,
        };
      }
    }),
    null,
    2
  );
};

const debug = makeDebug('ember-auto-import:analyzer');

export type TreeType = 'app' | 'addon' | 'addon-templates' | 'addon-test-support' | 'styles' | 'templates' | 'test';

interface BaseImport {
  path: string;
  package: Package;
  isDynamic: boolean;
  treeType: TreeType | undefined;
}

export interface LiteralImport extends BaseImport {
  specifier: string;
}

export interface TemplateImport extends BaseImport {
  // these are the string parts of the template literal. The first one always
  // comes before the first expression.
  cookedQuasis: string[];
  // for each of the expressions in between the cookedQuasis, this is an
  // optional hint for what to name the expression that goes there. It's
  // optional because in general there may not be an obvious name, but in
  // practice there often is, and we can aid debuggability by using names that
  // match the original code.
  expressionNameHints: (string | undefined)[];
}

export type Import = LiteralImport | TemplateImport;

/*
  Analyzer discovers and maintains info on all the module imports that
  appear in a broccoli tree.
*/
export default class Analyzer extends Plugin {
  private previousTree = new FSTree();
  private modules: Import[] | null = [];
  private paths: Map<string, Import[]> = new Map();

  private parse: undefined | ((source: string) => File | Program);

  constructor(inputTree: Node, private pack: Package, private treeType?: TreeType) {
    super([inputTree], {
      annotation: 'ember-auto-import-analyzer',
      persistentOutput: true,
    });
  }

  async setupParser(): Promise<void> {
    if (this.parse) {
      return;
    }

    if (this.pack.useSwcParser) {
      console.log('swc parser')
      this.parse = await swcParser(this.pack.swcOptions);
      return;
    }

    console.log('babel parser')
    switch (this.pack.babelMajorVersion) {
      case 7:
        this.parse = await babel7Parser(this.pack.babelOptions);
        break;
      default:
        throw new Error(
          `don't know how to setup a parser for Babel version ${this.pack.babelMajorVersion} (used by ${this.pack.name})`
        );
    }
  }

  get imports(): Import[] {
    if (!this.modules) {
      this.modules = flatten([...this.paths.values()]);
      debug('imports %m', this.modules);
    }
    return this.modules;
  }

  async build() {
    await this.setupParser();
    this.getPatchset().forEach(([operation, relativePath]) => {
      let outputPath = join(this.outputPath, relativePath);

      switch (operation) {
        case 'unlink':
          if (this.matchesExtension(relativePath)) {
            this.removeImports(relativePath);
          }
          unlinkSync(outputPath);
          break;
        case 'rmdir':
          rmdirSync(outputPath);
          break;
        case 'mkdir':
          mkdirSync(outputPath);
          break;
        case 'change':
          removeSync(outputPath);
        // deliberate fallthrough
        case 'create': {
          let absoluteInputPath = join(this.inputPaths[0], relativePath);
          if (this.matchesExtension(relativePath)) {
            this.updateImports(relativePath, readFileSync(absoluteInputPath, 'utf8'));
          }
          symlinkOrCopy.sync(absoluteInputPath, outputPath);
        }
      }
    });
  }

  private getPatchset() {
    let input = walkSync.entries(this.inputPaths[0]);
    let previous = this.previousTree;
    let next = (this.previousTree = FSTree.fromEntries(input));
    return previous.calculatePatch(next);
  }

  private matchesExtension(path: string) {
    return this.pack.fileExtensions.includes(extname(path).slice(1));
  }

  removeImports(relativePath: string) {
    debug(`removing imports for ${relativePath}`);
    let imports = this.paths.get(relativePath);
    if (imports) {
      if (imports.length > 0) {
        this.modules = null; // invalidates cache
      }
      this.paths.delete(relativePath);
    }
  }

  updateImports(relativePath: string, source: string) {
    // console.time("updateImports");
    debug(`updating imports for ${relativePath}, ${source.length}`);
    let newImports = this.parseImports(relativePath, source);
    if (!isEqual(this.paths.get(relativePath), newImports)) {
      this.paths.set(relativePath, newImports);
      this.modules = null; // invalidates cache
    }
    // console.timeEnd("updateImports");
  }

  private processImportCallExpression(
    relativePath: string,
    args: CallExpression['arguments'],
    isDynamic: boolean
  ): Import {
    // it's a syntax error to have anything other than exactly one
    // argument, so we can just assume this exists
    let argument = args[0];

    switch (argument.type) {
      case 'StringLiteral':
        return {
          isDynamic,
          specifier: argument.value,
          path: relativePath,
          package: this.pack,
          treeType: this.treeType,
        };
      case 'TemplateLiteral':
        if (argument.quasis.length === 1) {
          return {
            isDynamic,
            specifier: argument.quasis[0].value.cooked!,
            path: relativePath,
            package: this.pack,
            treeType: this.treeType,
          };
        } else {
          return {
            isDynamic,
            cookedQuasis: argument.quasis.map(templateElement => templateElement.value.cooked!),
            expressionNameHints: [...argument.expressions].map(inferNameHint),
            path: relativePath,
            package: this.pack,
            treeType: this.treeType,
          };
        }
      default:
        throw new Error('import() is only allowed to contain string literals or template string literals');
    }
  }

  private parseImports(relativePath: string, source: string): Import[] {
    let ast: File | Program | undefined;
    try {
      ast = this.parse!(source);
    } catch (err) {
      if (err.name !== 'SyntaxError') {
        throw err;
      }
      debug('Ignoring an unparseable file');
    }
    let imports: Import[] = [];
    if (!ast) {
      return imports;
    }

    if (this.pack.useSwcParser) {
      let self = this;
      class ImportAnalyzer extends Visitor {
        visitCallExpression(e: SwcCallExpression) {
          let callee;
          if (
            e.callee.type === 'MemberExpression' &&
            //@ts-ignore
            e.callee.object.callee?.value === 'import'
          ) {
            callee = e.callee.object;
          } else if (e.callee.type === 'Identifier' && e.callee.value === 'import') {
            callee = e;
          }
          if (callee) {
            // it's a syntax error to have anything other than exactly one
            // argument, so we can just assume this exists
            //@ts-ignore
            let argument = callee.arguments[0];

            switch (argument.expression.type) {
              case 'StringLiteral':
                imports.push({
                  isDynamic: true,
                  specifier: argument.expression.value,
                  path: relativePath,
                  package: self.pack,
                  treeType: self.treeType,
                });
                break;
              case 'TemplateLiteral':
                let expression = argument.expression;
                if (expression.quasis.length === 1) {
                  imports.push({
                    isDynamic: true,
                    specifier: expression.quasis[0].cooked.value,
                    path: relativePath,
                    package: self.pack,
                    treeType: self.treeType,
                  });
                } else {
                  imports.push({
                    isDynamic: true,
                    cookedQuasis: expression.quasis.map(
                      (templateElement: SwcTemplateElement) => templateElement.cooked.value
                    ),
                    expressionNameHints: [...expression.expressions].map(swcInferNameHint),
                    path: relativePath,
                    package: self.pack,
                    treeType: self.treeType,
                  });
                }
                break;
              default:
                throw new Error('import() is only allowed to contain string literals or template string literals');
            }
          }
          return e;
        }

        visitImportDeclaration(e: SwcImportDeclaration) {
          imports.push({
            isDynamic: false,
            specifier: e.source.value,
            path: relativePath,
            package: self.pack,
            treeType: self.treeType,
          });
          return e;
        }

        visitExportNamedDeclaration(e: SwcExportNamedDeclaration) {
          if (e.source) {
            imports.push({
              isDynamic: false,
              specifier: e.source.value,
              path: relativePath,
              package: self.pack,
              treeType: self.treeType,
            });
          }
          return e;
        }
      }
      swcTransfromSync(ast as Program, {
        plugin: m => new ImportAnalyzer().visitProgram(m),
      });
    } else {
      traverse(ast as File, {
        CallExpression: path => {
          let callee = path.get('callee');
          if (callee.type === 'Import') {
            imports.push(this.processImportCallExpression(relativePath, path.node.arguments, true));
          } else if (callee.isIdentifier() && callee.referencesImport('@embroider/macros', 'importSync')) {
            imports.push(this.processImportCallExpression(relativePath, path.node.arguments, false));
          }
        },
        ImportDeclaration: path => {
          imports.push({
            isDynamic: false,
            specifier: path.node.source.value,
            path: relativePath,
            package: this.pack,
            treeType: this.treeType,
          });
        },
        ExportNamedDeclaration: path => {
          if (path.node.source) {
            imports.push({
              isDynamic: false,
              specifier: path.node.source.value,
              path: relativePath,
              package: this.pack,
              treeType: this.treeType,
            });
          }
        },
      });
    }
    return imports;
  }
}

async function swcParser(swcOptions: ParseOptions): Promise<(source: string) => Program> {
  let swc = import('@swc/core');

  const { parseSync } = await swc;
  return function (source: string) {
    return parseSync(
      source,
      Object.assign(
        {
          dynamicImport: true,
          decorators: true,
        },
        swcOptions
      )
    ) as Program;
  };
}

async function babel7Parser(babelOptions: TransformOptions): Promise<(source: string) => File> {
  let core = import('@babel/core');

  const { parseSync } = await core;
  return function (source: string) {
    return parseSync(source, babelOptions) as File;
  };
}

function swcInferNameHint(exp: SwcExpression | TSType) {
  if (exp.type === 'Identifier') {
    return exp.value;
  }
}

function inferNameHint(exp: Expression | TSType) {
  if (exp.type === 'Identifier') {
    return exp.name;
  }
}
