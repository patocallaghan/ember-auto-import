import Plugin, { Tree } from 'broccoli-plugin';
import makeDebug from 'debug';
import { isEqual, flatten } from 'lodash';
import Package from './package';
import { File } from '@babel/types';

makeDebug.formatters.m = (modules: Import[]) => {
  return JSON.stringify(
    modules.map(m => ({
      specifier: m.specifier,
      path: m.path,
      isDynamic: m.isDynamic,
      package: m.package.name
    })),
    null,
    2
  );
};

const debug = makeDebug('ember-auto-import:analyzer');

export interface Import {
  path: string;
  package: Package;
  specifier: string;
  isDynamic: boolean;
}

/*
  Analyzer discovers and maintains info on all the module imports that
  appear in a broccoli tree.
*/
export default class Analyzer extends Plugin {
  private modules: Import[] | null = [];
  private paths: Map<string, Import[]> = new Map();

  private parse: undefined | ((source: string) => File);

  constructor(inputTree: Tree) {
    super([inputTree], {
      annotation: 'ember-auto-import-analyzer',
      persistentOutput: true
    });
  }

  get imports(): Import[] {
    if (!this.modules) {
      this.modules = flatten([...this.paths.values()]);
      debug('imports %m', this.modules);
    }
    return this.modules;
  }

  async build() {}
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
    debug(`updating imports for ${relativePath}, ${source.length}`);
    let newImports = this.parseImports(relativePath, source);
    if (!isEqual(this.paths.get(relativePath), newImports)) {
      this.paths.set(relativePath, newImports);
      this.modules = null; // invalidates cache
    }
  }

  private parseImports(_relativePath :string, source: string): Import[] {
    let ast: File | undefined;
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

    return imports;
  }
}