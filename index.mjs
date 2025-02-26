import fs from 'fs/promises';
import path from 'path';
import * as ts from 'typescript';

async function analyzeExports(inputFile) {
  try {
    // Read the file content
    const fileContent = await fs.readFile(inputFile, 'utf8');
    
    // Create a TypeScript program
    const program = ts.createProgram([inputFile], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      checkJs: true,
      jsx: ts.JsxEmit.React,
      jsxFactory: 'React.createElement',
      jsxFragmentFactory: 'React.Fragment',
    });
    
    // Get the source file
    const sourceFile = program.getSourceFile(inputFile);
    if (!sourceFile) {
      console.error(`Could not find source file: ${inputFile}`);
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

async function main() {
  try {
    // Read package.json from current working directory
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    
    if (!packageJson.main) {
      console.error('Error: No "main" field found in package.json');
      process.exit(1);
    }
    
    // Resolve the main file path relative to the current working directory
    const inputFile = path.resolve(process.cwd(), packageJson.main);
    
    try {
      await fs.access(inputFile);
      await analyzeExports(inputFile);
    } catch (error) {
      console.error(`Error reading main file: ${error.message}`);
    }
  } catch (error) {
    console.error(`Error reading package.json: ${error.message}`);
  }
}

main();
