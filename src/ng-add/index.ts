import * as ts from "typescript";
import {
  Rule,
  SchematicContext,
  Tree,
  chain,
  noop
} from "@angular-devkit/schematics";
import { NodePackageInstallTask } from "@angular-devkit/schematics/tasks";

export interface Host {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

export interface Change {
  apply(host: Host): Promise<void>;

  // The file this change should be applied to. Some changes might not apply to
  // a file (maybe the config).
  readonly path: string | null;

  // The order this change should be applied. Normally the position inside the file.
  // Changes are applied from the bottom of a file to the top.
  readonly order: number;

  // The description of this change. This will be outputted in a dry or verbose run.
  readonly description: string;
}

export class InsertChange implements Change {
  order: number;
  description: string;

  constructor(public path: string, public pos: number, public toAdd: string) {
    if (pos < 0) {
      throw new Error("Negative positions are invalid");
    }
    this.description = `Inserted ${toAdd} into position ${pos} of ${path}`;
    this.order = pos;
  }

  /**
   * This method does not insert spaces if there is none in the original string.
   */
  apply(host: Host) {
    return host.read(this.path).then(content => {
      const prefix = content.substring(0, this.pos);
      const suffix = content.substring(this.pos);

      return host.write(this.path, `${prefix}${this.toAdd}${suffix}`);
    });
  }
}

/**
 * Get all the nodes from a source.
 * @param sourceFile The source file object.
 * @returns {Observable<ts.Node>} An observable of all the nodes in the source.
 */
export function getSourceNodes(sourceFile: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [sourceFile];
  const result = [];

  while (nodes.length > 0) {
    const node = nodes.shift();

    if (node) {
      result.push(node);
      if (node.getChildCount(sourceFile) >= 0) {
        nodes.unshift(...node.getChildren());
      }
    }
  }

  return result;
}

function addPackageToPackageJson(tree: Tree, context: SchematicContext): Tree {
  if (tree.exists("package.json")) {
    const sourceText = tree.read("package.json")!.toString("utf-8");
    const packageJson = JSON.parse(sourceText);
    if (!packageJson.devDependencies) {
      packageJson.devDependencies = {};
    }

    if (!packageJson.devDependencies.puppeteer) {
      packageJson.devDependencies.puppeteer = "*";
    }

    if (!packageJson.devDependencies["karma-chrome-launcher"]) {
      packageJson.devDependencies["karma-chrome-launcher"] = "*";
    }

    tree.overwrite("package.json", JSON.stringify(packageJson, null, 2));
  }

  return tree;
}

function addPackages() {
  return (host: Tree, context: SchematicContext) => {
    addPackageToPackageJson(host, context);
    context.addTask(new NodePackageInstallTask());
    return host;
  };
}

function addProtractor(): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const protractorPath = "e2e/protractor.conf.js";

    if (tree.exists(protractorPath)) {
      const protractorConfText = tree.read(protractorPath)!.toString("utf-8");
      const protractorConf = ts.createSourceFile(
        protractorPath,
        protractorConfText,
        ts.ScriptTarget.Latest,
        true
      );

      // context.logger.info(typeof protractorConf.statements[0]);

      /* Need to add
      import * as puppeteer from 'puppeteer';

      and...

      chromeOptions: {
      args: process.env.HEADLESS
        ? ['--headless', '--no-sandbox', '--disable-dev-shm-usage']
        : [],
      binary: puppeteer.executablePath() : undefined,
    },
      */

      const changes = [
        new InsertChange(
          protractorPath,
          0,
          "var puppeteer = require('puppeteer');\n"
        )
      ];

      let configNode = getSourceNodes(protractorConf)
        .filter(node => {
          return (
            node.kind == ts.SyntaxKind.ExpressionStatement &&
            (node as ts.ExpressionStatement).expression.kind ==
              ts.SyntaxKind.BinaryExpression
          );
        })
        .map(
          node =>
            (node as ts.ExpressionStatement).expression as ts.BinaryExpression
        )
        .filter(expr => {
          return (
            (expr.left as ts.PropertyAccessExpression).name.text === "config"
          );
        })
        .map(
          node =>
            (node as ts.BinaryExpression).right as ts.ObjectLiteralExpression
        )[0] as ts.ObjectLiteralExpression;

      // Get all the children property assignment of object literals.
      const matchingProperties: ts.ObjectLiteralElement[] = (configNode as ts.ObjectLiteralExpression).properties
        .filter(prop => prop.kind == ts.SyntaxKind.PropertyAssignment)
        // Filter out every fields that's not "'chromeOptions'". Also handles string literals
        // (but not expressions).
        .filter((prop: any) => {
          const name = prop.name;
          switch (name.kind) {
            case ts.SyntaxKind.Identifier:
              return (
                (name as ts.Identifier).getText(protractorConf) ==
                "chromeOptions"
              );
            case ts.SyntaxKind.StringLiteral:
              return (name as ts.StringLiteral).text == "chromeOptions";
          }

          return false;
        });

      // Get the last node of the array literal.
      // if (!matchingProperties) {
      //   return [];
      // }
      if (matchingProperties.length == 0) {
        // We haven't found the field in the metadata declaration. Insert a new field.
        const expr = configNode as ts.ObjectLiteralExpression;
        let position: number;
        let toInsert: string;
        if (expr.properties.length == 0) {
          position = expr.getEnd() - 1;
          toInsert = `  ${"chromeOptions"}: {args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}\n`;
        } else {
          position = expr.properties[expr.properties.length - 1].getEnd();
          toInsert = `, ${"chromeOptions"}: {args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}`;
        }
        const newConfigProperty = new InsertChange(
          protractorPath,
          position,
          toInsert
        );
        changes.push(newConfigProperty);
      }

      const recorder = tree.beginUpdate(protractorPath);

      for (const change of changes) {
        if (change instanceof InsertChange) {
          recorder.insertLeft(change.pos, change.toAdd);
        }
      }
      tree.commitUpdate(recorder);

      return tree;
    }
  };
}

// You don't have to export the function as default. You can also have more than one rule factory
// per file.
export function puppeteerSchematic(options: any): Rule {
  return (tree: Tree, context: SchematicContext) => {
    // Show the options for this Schematics.
    // The logging here is at the discretion of the tooling. It can be ignored or only showing
    // info/warnings/errors. If you use console.log() there is not guarantee it will be
    // propagated to a user in any way (for example, an IDE running this schematic might
    // have a logging window but no support for console.log).
    context.logger.info("My Schematic: " + JSON.stringify(options));

    // if (tree.exists("src/karma.conf.js")) {
    //   const karmaConfText = tree.read("src/karma.conf.js")!.toString("utf-8");
    //   const karmaConf = ts.createSourceFile(
    //     "src/karma.conf.js",
    //     karmaConfText,
    //     ts.ScriptTarget.Latest,
    //     true
    //   );
    //   /* Need to add
    //   import * as puppeteer from 'puppeteer';
    //   process.env.CHROME_BIN = require('puppeteer').executablePath();

    //   and...

    //   config.set({
    //     browsers: ['ChromeHeadless']
    //   })
    //   */
    //   // tree.overwrite("src/karma.conf.js", JSON.stringify(json, null, 2));
    // }

    // Create a single file. This is the simplest example of transforming the tree.
    // If a file with that name already exists, the generation will NOT fail until the tool
    // is trying to commit this to disk. This is because we allow you to work on what is
    // called a "staging" area, and only finalize those changes when the schematics is
    // done. This allows you to create files without having to verify if they exist
    // already, then rename them later. Templating works in a similar fashion.
    // tree.create('hello', 'world');

    return chain([
      // options && options.skipPackageJson ? noop() : addPackages(),
      addProtractor()
    ])(tree, context);
  };
}
