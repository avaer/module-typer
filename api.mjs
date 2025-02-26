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

async function getExportsSchema(inputFile, env) {
  try {
    // Load the file
    const loadFile = getFileLoader(inputFile);
    const { content, error } = await loadFile(inputFile, env);
    if (error) {
      console.error(`File error: ${error}`);
      return { error };
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
      return { error: 'Source file not found' };
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
    
    // Convert TypeScript types to JSON Schema
    function typeToJsonSchema(typeString) {
      // Handle primitive types
      if (typeString === 'string') return { type: 'string' };
      if (typeString === 'number') return { type: 'number' };
      if (typeString === 'boolean') return { type: 'boolean' };
      if (typeString === 'null') return { type: 'null' };
      if (typeString === 'undefined') return { type: 'null' };
      if (typeString === 'any' || typeString === 'unknown') return {};
      
      // Handle arrays
      if (typeString.endsWith('[]')) {
        const itemType = typeString.slice(0, -2);
        return {
          type: 'array',
          items: typeToJsonSchema(itemType)
        };
      }
      
      // Handle React components
      if (typeString.includes('React.FC<') || typeString.includes('FunctionComponent<')) {
        // Extract props type from React component
        let propsType = 'any';
        const propsMatch = typeString.match(/<(.+)>/s); // Added 's' flag to match across multiple lines
        
        if (propsMatch && propsMatch[1]) {
          propsType = propsMatch[1].trim();
          // If the props type is an inline object definition, parse it directly
          if (propsType.startsWith('{') && propsType.endsWith('}')) {
            return {
              type: "object",
              description: `React Component: ${typeString}`,
              properties: typeToJsonSchema(propsType).properties
            };
          }
        }
        
        return {
          type: "object",
          description: `React Component: ${typeString}`,
          tsType: typeString
        };
      }
      
      // Handle objects and interfaces
      if (typeString.startsWith('{') && typeString.endsWith('}')) {
        const schema = {
          type: 'object',
          properties: {},
          required: []
        };
        
        // More robust parsing for object properties
        // This handles multiline object definitions better
        const propertyRegex = /(\w+)(\?)?:\s*([^;]+);/g;
        let match;
        
        while ((match = propertyRegex.exec(typeString)) !== null) {
          const [, name, optional, type] = match;
          schema.properties[name] = typeToJsonSchema(type.trim());
          
          if (!optional) {
            schema.required.push(name);
          }
        }
        
        if (schema.required.length === 0) {
          delete schema.required;
        }
        
        return schema;
      }
      
      // Handle unions
      if (typeString.includes(' | ')) {
        const types = typeString.split(' | ').map(t => t.trim());
        
        // Check for null or undefined in union (optional)
        const hasNull = types.some(t => t === 'null' || t === 'undefined');
        const nonNullTypes = types.filter(t => t !== 'null' && t !== 'undefined');
        
        if (nonNullTypes.length === 1 && hasNull) {
          const schema = typeToJsonSchema(nonNullTypes[0]);
          schema.nullable = true;
          return schema;
        }
        
        return {
          oneOf: types.map(t => typeToJsonSchema(t))
        };
      }
      
      // Handle function types
      if (typeString.includes('=>') || typeString.startsWith('(')) {
        // Extract parameter and return type information
        let params = [];
        let returnType = 'any';
        
        // Parse function signature
        const functionMatch = typeString.match(/\(([^)]*)\)\s*=>\s*(.+)/);
        if (functionMatch) {
          const paramString = functionMatch[1];
          returnType = functionMatch[2].trim();
          
          // Parse parameters
          if (paramString.trim()) {
            params = paramString.split(',').map(param => {
              const [name, type] = param.split(':').map(p => p.trim());
              return { name, type: type || 'any' };
            });
          }
        }
        
        return { 
          type: "object",
          description: `Function: ${typeString}`,
          parameters: params.map(p => ({
            name: p.name,
            schema: typeToJsonSchema(p.type)
          })),
          returns: typeToJsonSchema(returnType)
        };
      }
      
      // Default case - use as string description
      return { type: 'string', description: `TypeScript type: ${typeString}` };
    }
    
    // Convert exports to JSON Schema
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {}
    };
    
    for (const exp of exports) {
      schema.properties[exp.name] = typeToJsonSchema(exp.type);
    }
    
    return schema;
  } catch (error) {
    console.error(`Error analyzing exports: ${error.message}`);
    return { error: error.message };
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
    
    return await getExportsSchema(resolvedPath, env);
  } catch (error) {
    console.error(`Error in main: ${error.message}`);
    return { error: error.message };
  }
};