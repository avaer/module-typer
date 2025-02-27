import path from 'path';
import fs from 'fs';
import os from 'os';
import * as ts from 'typescript';
import { isGithubUrl } from './lib/util.mjs';
import tsj from 'ts-json-schema-generator';
import { rimraf } from 'rimraf';

// Helper function to resolve the main file from a directory or GitHub repo
async function resolveMainFile(inputPath, {
  loadFile,
}) {
  const packageJsonPath = (() => {
    if (isGithubUrl(inputPath)) {
      const u = new URL(inputPath);
      u.pathname = u.pathname + '/blob/main/package.json';
      return u.toString();
    } else {
      return path.join(inputPath, 'package.json');
    }
  })();
  const { content, error } = await loadFile(packageJsonPath);
  if (error) {
    throw new Error(`Error reading package.json from directory: ${error}`);
  }
  const packageJson = JSON.parse(content);
  if (!packageJson.main) {
    throw new Error('No "main" field found in package.json');
  }
  // const mainFilePath = path.join(inputPath, packageJson.main);
  const mainFilePath = (() => {
    if (isGithubUrl(inputPath)) {
      const u = new URL(inputPath);
      u.pathname = u.pathname + '/blob/main/' + packageJson.main;
      return u.toString();
    } else {
      return path.join(inputPath, packageJson.main);
    }
  })();
  return mainFilePath;
}

async function getExportsSchema(inputFile, {
  loadFile,
}) {
  try {
    // Load the file
    const { content, error } = await loadFile(inputFile);
    if (error) {
      console.error(`File error: ${error}`);
      return { error };
    }
    
    // Create a virtual file system for TypeScript
    const fileName = isGithubUrl(inputFile) ? 
      path.basename(inputFile) : 
      inputFile;
    
    // Create a virtual file system for the compiler
    const compilerHost = {
      getSourceFile: (name) => {
        if (name === fileName) {
          return ts.createSourceFile(
            fileName,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX
          );
        }
        return undefined;
      },
      getDefaultLibFileName: () => "lib.d.ts",
      getCurrentDirectory: () => "/",
      fileExists: () => true,
      readFile: () => "",
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
    };
    
    // Create a program to represent our single file
    const program = ts.createProgram([fileName], {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      checkJs: true,
    }, compilerHost);
    
    // Get the source file
    const sourceFile = program.getSourceFile(fileName);

    const allSchemas = await (async () => {
      // make a temp file for the source
      const tempFilePath = path.join(os.tmpdir(), `temp-${Date.now()}.tsx`);
      // write the content
      await fs.promises.writeFile(tempFilePath, content);

      const config = {
        path: tempFilePath,
        tsconfig: path.join(process.cwd(), 'tsconfig.json'),
        type: "*", // Or <type-name> if you want to generate schema for that one type only
        skipTypeCheck: true,
      };
      const schema = tsj.createGenerator(config).createSchema(config.type);
      await rimraf(tempFilePath);
      return schema.definitions;
    })();
    // console.log('allSchemas', JSON.stringify(allSchemas, null, 2));

    const exportNames = (() => {
      // Find all exported declarations
      const exportNames = [];

      // Visit each node in the source file
      ts.forEachChild(sourceFile, node => {
        // Check for export declarations
        if (ts.isExportDeclaration(node)) {
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            // Handle named exports like: export { foo, bar }
            node.exportClause.elements.forEach(element => {
              if (!exportNames.includes(element.name.text)) {
                exportNames.push(element.name.text);
              }
            });
          }
        } 
        // Check for exported variables, functions, classes, etc.
        else if (
          (ts.isVariableStatement(node) || 
          ts.isFunctionDeclaration(node) || 
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node)) && 
          node.modifiers && 
          node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          if (ts.isVariableStatement(node)) {
            // Handle: export const foo = 1, bar = 2
            node.declarationList.declarations.forEach(declaration => {
              if (declaration.name && ts.isIdentifier(declaration.name)) {
                if (!exportNames.includes(declaration.name.text)) {
                  exportNames.push(declaration.name.text);
                }
              }
            });
          } else if (node.name && ts.isIdentifier(node.name)) {
            // Handle: export function foo() {}, export class Bar {}, etc.
            if (!exportNames.includes(node.name.text)) {
              exportNames.push(node.name.text);
            }
          }
        }
        // Check for default exports
        else if (
          (ts.isFunctionDeclaration(node) || 
          ts.isClassDeclaration(node)) && 
          node.modifiers && 
          node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
          node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
        ) {
          if (!exportNames.includes("default")) {
            exportNames.push("default");
          }
        }
        // Handle export default expression
        else if (
          ts.isExportAssignment(node) && 
          !node.isExportEquals
        ) {
          if (!exportNames.includes("default")) {
            exportNames.push("default");
          }
        }
      });
      return exportNames;
    })();
    // console.log('exportNames', exportNames);

    const exports = (() => {
      const exports = {};
      for (const name of exportNames) {
        exports[name] = allSchemas[name];
      }
      return exports;
    })();

    // Create the JSON schema
    const schema = {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": exports,
    };
    
    return schema;
  } catch (error) {
    console.error(`Error analyzing exports: ${error.message}`);
    return { error: error.message };
  }
}

export const fetchTypes = async (providedPath, {
  loadFile,
}) => {
  try {
    // Normalize the path - for local paths, resolve to absolute path
    const normalizedPath = isGithubUrl(providedPath)
      ? providedPath 
      : path.resolve(process.cwd(), providedPath);
    
    // Resolve the main file if it's a directory or repository
    const resolvedPath = await resolveMainFile(normalizedPath, {
      loadFile,
    });
    
    return await getExportsSchema(resolvedPath, {
      loadFile,
    });
  } catch (error) {
    console.error(`Error in main: ${error.message}`);
    return { error: error.message };
  }
};