import fs from 'fs/promises';
import path from 'path';
import * as ts from 'typescript';
import url from 'url';

export async function loadLocalFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, error: null };
  } catch (error) {
    return { content: null, error: error.message };
  }
}

async function loadGithubFile(githubUrl) {
  try {
    // Convert GitHub URL to raw content URL
    // Format: https://github.com/owner/repo/blob/branch/path/to/file.js
    // To: https://raw.githubusercontent.com/owner/repo/branch/path/to/file.js
    const rawUrl = githubUrl
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/blob/', '/');
    
    const response = await fetch(rawUrl);
    
    if (!response.ok) {
      return { content: null, error: `Failed to fetch: ${response.statusText}` };
    }
    
    const content = await response.text();
    return { content, error: null };
  } catch (error) {
    return { content: null, error: error.message };
  }
}

// Helper function to determine if a path is a GitHub URL
function isGithubUrl(path) {
  return path.startsWith('https://github.com/') && path.includes('/blob/');
}

// Helper function to determine if a path is a GitHub repository URL (without /blob/)
function isGithubRepoUrl(path) {
  return path.startsWith('https://github.com/') && !path.includes('/blob/');
}

// Function to choose the appropriate loader based on the path
function getFileLoader(filePath) {
  return isGithubUrl(filePath) || isGithubRepoUrl(filePath) ? loadGithubFile : loadLocalFile;
}

// Helper function to check if a path is a directory
async function isDirectory(path) {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

// Helper function to resolve the main file from a directory or GitHub repo
async function resolveMainFile(inputPath) {
  // For GitHub repositories
  if (isGithubRepoUrl(inputPath)) {
    // Convert to raw URL for package.json
    // Format: https://github.com/owner/repo
    // To: https://raw.githubusercontent.com/owner/repo/master/package.json
    const rawPackageJsonUrl = inputPath
      .replace('github.com', 'raw.githubusercontent.com')
      + '/master/package.json';
    
    const { content, error } = await loadGithubFile(rawPackageJsonUrl);
    
    if (error) {
      throw new Error(`Error reading package.json from GitHub repo: ${error}`);
    }
    
    const packageJson = JSON.parse(content);
    
    if (!packageJson.main) {
      throw new Error('No "main" field found in package.json');
    }
    
    // Construct the full GitHub URL to the main file
    const mainFilePath = inputPath
      .replace('github.com', 'raw.githubusercontent.com')
      + '/master/' + packageJson.main;
    
    return { 
      path: mainFilePath,
      loader: loadGithubFile
    };
  }
  
  // For local directories
  if (await isDirectory(inputPath)) {
    const packageJsonPath = path.join(inputPath, 'package.json');
    const { content, error } = await loadLocalFile(packageJsonPath);
    
    if (error) {
      throw new Error(`Error reading package.json from directory: ${error}`);
    }
    
    const packageJson = JSON.parse(content);
    
    if (!packageJson.main) {
      throw new Error('No "main" field found in package.json');
    }
    
    // Resolve the main file path relative to the directory
    const mainFilePath = path.resolve(inputPath, packageJson.main);
    
    return {
      path: mainFilePath,
      loader: loadLocalFile
    };
  }
  
  // For direct file paths (local or GitHub)
  return {
    path: inputPath,
    loader: getFileLoader(inputPath)
  };
}

async function analyzeExports(inputFile, {
  loadFile,
}) {
  try {
    // Load the file
    const { content, error } = await loadFile(inputFile);
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

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const main = async () => {
    try {
      // Check if a file path is provided as an argument
      const providedPath = process.argv[2];
      
      if (providedPath) {
        // Normalize the path - for local paths, resolve to absolute path
        const normalizedPath = isGithubUrl(providedPath) || isGithubRepoUrl(providedPath) 
          ? providedPath 
          : path.resolve(process.cwd(), providedPath);
        
        // Resolve the main file if it's a directory or repository
        const { path: resolvedPath, loader } = await resolveMainFile(normalizedPath);
        
        await analyzeExports(resolvedPath, {
          loadFile: loader,
        });
      } else {
        // Fallback to using package.json main field in current directory
        const packageJsonPath = path.resolve(process.cwd(), 'package.json');
        const { content: packageJsonContent, error: packageJsonError } = await loadLocalFile(packageJsonPath);
        
        if (packageJsonError) {
          console.error(`Error reading package.json: ${packageJsonError}`);
          process.exit(1);
        }
        
        const packageJson = JSON.parse(packageJsonContent);
        
        if (!packageJson.main) {
          console.error('Error: No "main" field found in package.json');
          process.exit(1);
        }
        
        // Resolve the main file path relative to the current working directory
        const inputFile = path.resolve(process.cwd(), packageJson.main);
        await analyzeExports(inputFile, {
          loadFile: loadLocalFile,
        });
      }
    } catch (error) {
      console.error(`Error in main: ${error.message}`);
    }
  };
  main();
}
