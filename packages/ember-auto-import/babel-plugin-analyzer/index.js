/* globals module */
'use strict';
const path = require('path');
const makeDebug = require('debug');
const debug = makeDebug('ember-auto-import:babel-plugin-analyzer');

module.exports = function() {
  let imports = [];
  return {
    name: 'import-declarations',

    visitor: {
      CallExpression: (path, state) => {
        if (path.node.callee.type === 'Import') {
          // it's a syntax error to have anything other than exactly one
          // argument, so we can just assume this exists
          let argument = path.node.arguments[0];
          if (argument.type !== 'StringLiteral') {
            throw new Error(
              'ember-auto-import only supports dynamic import() with a string literal argument.'
            );
          }
          debug(`dynamic import: ${state.file.opts.filename}`)
          imports.push({
            isDynamic: true,
            specifier: argument.value,
            path: '',
            package: {}
          });
        }
      },
      ImportDeclaration: (path, state) => {
        debug(`import: ${state.file.opts.filename}`);
        imports.push({
          isDynamic: false,
          specifier: path.node.source.value,
          path: '',
          package: {}
        });
      },
      ExportNamedDeclaration: (path, state) => {
        debug(`export: ${state.file.opts.filename}`);
        if (path.node.source) {
          imports.push({
            isDynamic: false,
            specifier: path.node.source.value,
            path: '',
            package: {}
          });
        }
      }
    },
  };
};

// Provide the path to the package's base directory for caching with broccoli
// Ref: https://github.com/babel/broccoli-babel-transpiler#caching
module.exports.baseDir = () => path.resolve(__dirname, '..');