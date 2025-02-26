import fs from 'fs/promises';
import path from 'path';
import * as ts from 'typescript';
import { Octokit } from '@octokit/rest';

async function loadLocalFile(filePath, env) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, error: null };
  } catch (error) {
    return { content: null, error: error.message };
  }
}

async function loadGithubFile(githubUrl, env) {
  try {
    // Parse GitHub URL components
    const url = new URL(githubUrl);
    const [, owner, repo, , branch, ...pathParts] = url.pathname.split('/');
    const filePath = pathParts.join('/');

    if (env.OCTOKIT_API) {
      // Use Octokit if API key is available
      const octokit = new Octokit({
        auth: env.OCTOKIT_API
      });

      const response = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch
      });

      const content = Buffer.from(response.data.content, 'base64').toString();
      return { content, error: null };

    } else {
      // Fallback to public API
      const rawUrl = new URL(githubUrl);
      rawUrl.hostname = 'raw.githubusercontent.com';
      rawUrl.pathname = rawUrl.pathname.replace('/blob/', '/');

      const response = await fetch(rawUrl);
      
      if (!response.ok) {
        return { content: null, error: `Failed to fetch: ${response.statusText}` };
      }
      
      const content = await response.text();
      return { content, error: null };
    }

  } catch (error) {
    return { content: null, error: error.message };
  }
}

// Helper function to determine if a path is a GitHub URL
function isGithubUrl(path) {
  return path.startsWith('https://github.com/');
}

// Function to choose the appropriate loader based on the path
function getFileLoader(filePath) {
  return isGithubUrl(filePath) ? loadGithubFile : loadLocalFile;
}

// Helper function to resolve the main file from a directory or GitHub repo
async function resolveMainFile(inputPath, env) {
  const packageJsonPath = (() => {
    if (isGithubUrl(inputPath)) {
      const u = new URL(inputPath);
      u.pathname = u.pathname + '/blob/main/package.json';
      return u.toString();
    } else {
      return path.join(inputPath, 'package.json');
    }
  })();
  const loadFile = getFileLoader(packageJsonPath);
  const { content, error } = await loadFile(packageJsonPath, env);
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

async function analyzeExports(inputFile, env) {
  try {
    // Load the file
    const loadFile = getFileLoader(inputFile);
    const { content, error } = await loadFile(inputFile, env);
    if (error) {
      console.error(`File error: ${error}`);
      return;
    }
    
    // Create a virtual file system for TypeScript
    const fileName = isGithubUrl(inputFile) ? 
      path.basename(inputFile) : 
      inputFile;
    
    // Create a compiler host that uses our in-memory content
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    
    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(name, content, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };
    
    // Create a TypeScript program using our custom host
    const program = ts.createProgram([fileName], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'React.createElement',
      jsxFragmentFactory: 'React.Fragment',
    }, compilerHost);
    
    // Get the source file
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      console.error(`Could not find source file: ${fileName}`);
      return;
    }
    
    // Get the type checker
    const typeChecker = program.getTypeChecker();
    
    // Find all export declarations
    const exports = [];
    
    // Helper function to get detailed type information
    function getDetailedType(symbol, location) {
      const type = typeChecker.getTypeOfSymbolAtLocation(symbol, location);
      let typeString = typeChecker.typeToString(type, undefined, 
        ts.TypeFormatFlags.NoTruncation | 
        ts.TypeFormatFlags.InTypeAlias |
        ts.TypeFormatFlags.MultilineObjectLiterals |
        ts.TypeFormatFlags.WriteClassExpressionAsTypeLiteral
      );
      
      // For React components with props, try to expand the props type
      if (typeString.includes('React.FC<') || typeString.includes('FunctionComponent<')) {
        // Extract the props type name
        const propsMatch = typeString.match(/FC<([^>]+)>/) || typeString.match(/FunctionComponent<([^>]+)>/);
        if (propsMatch && propsMatch[1]) {
          const propsTypeName = propsMatch[1].trim();
          
          // Find the props type declaration
          let propsType = null;
          ts.forEachChild(sourceFile, node => {
            if (ts.isInterfaceDeclaration(node) && node.name.text === propsTypeName) {
              propsType = expandInterface(node);
            } else if (ts.isTypeAliasDeclaration(node) && node.name.text === propsTypeName) {
              propsType = expandTypeAlias(node);
            }
          });
          
          if (propsType) {
            // Return only the fully resolved type
            return `React.FC<${propsType}>`;
          }
        }
      }
      
      return typeString;
    }
    
    // Helper function to expand interface declarations
    function expandInterface(interfaceDecl) {
      let result = '{\n';
      
      if (interfaceDecl.members) {
        interfaceDecl.members.forEach(member => {
          if (ts.isPropertySignature(member) && member.name && member.type) {
            const propertyName = member.name.getText(sourceFile);
            const propertyType = member.type.getText(sourceFile);
            result += `  ${propertyName}: ${propertyType};\n`;
          } else if (ts.isMethodSignature(member) && member.name) {
            const methodName = member.name.getText(sourceFile);
            const returnType = member.type ? member.type.getText(sourceFile) : 'any';
            const params = member.parameters.map(p => p.getText(sourceFile)).join(', ');
            result += `  ${methodName}(${params}): ${returnType};\n`;
          }
        });
      }
      
      result += '}';
      return result;
    }
    
    // Helper function to expand type alias declarations
    function expandTypeAlias(typeAliasDecl) {
      if (typeAliasDecl.type) {
        return typeAliasDecl.type.getText(sourceFile);
      }
      return 'unknown';
    }
    
    ts.forEachChild(sourceFile, node => {
      // Handle export declarations
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach(element => {
            const symbol = typeChecker.getSymbolAtLocation(element.name);
            if (symbol) {
              const type = getDetailedType(symbol, element.name);
              exports.push({ name: element.name.text, type });
            }
          });
        }
      }
      
      // Handle export assignments (export default)
      else if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const symbol = typeChecker.getSymbolAtLocation(node.expression);
        if (symbol) {
          const type = getDetailedType(symbol, node.expression);
          exports.push({ name: 'default', type });
        }
      }
      
      // Handle variable, function, class declarations with export keyword
      else if ((ts.isVariableStatement(node) || 
                ts.isFunctionDeclaration(node) || 
                ts.isClassDeclaration(node)) && 
               node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        
        if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach(declaration => {
            if (ts.isIdentifier(declaration.name)) {
              const symbol = typeChecker.getSymbolAtLocation(declaration.name);
              if (symbol) {
                const type = getDetailedType(symbol, declaration.name);
                exports.push({ name: declaration.name.text, type });
              }
            }
          });
        } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
          if (node.name) {
            const symbol = typeChecker.getSymbolAtLocation(node.name);
            if (symbol) {
              const type = getDetailedType(symbol, node.name);
              exports.push({ name: node.name.text, type });
            }
          }
        }
      }
    });
    
    // Print the results
    if (exports.length > 0) {
      console.log(`Exports found in ${inputFile}:`);
      for (const exp of exports) {
        console.log(` - ${exp.name}: ${exp.type}`);
      }
    } else {
      console.log(`No exports found in ${inputFile}`);
    }
  } catch (error) {
    console.error(`Error analyzing exports: ${error.message}`);
  }
}

export const fetchTypes = async (providedPath, {
  env = {},
} = {}) => {
  try {
    // Normalize the path - for local paths, resolve to absolute path
    const normalizedPath = isGithubUrl(providedPath)
      ? providedPath 
      : path.resolve(process.cwd(), providedPath);
    
    // Resolve the main file if it's a directory or repository
    const resolvedPath = await resolveMainFile(normalizedPath, env);
    
    await analyzeExports(resolvedPath, env);
  } catch (error) {
    console.error(`Error in main: ${error.message}`);
  }
};