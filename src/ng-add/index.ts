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

export class ReplaceChange implements Change {
  order: number;
  description: string;

  constructor(
    public path: string,
    private pos: number,
    public oldText: string,
    public newText: string
  ) {
    if (pos < 0) {
      throw new Error("Negative positions are invalid");
    }
    this.description = `Replaced ${oldText} into position ${pos} of ${path} with ${newText}`;
    this.order = pos;
  }

  apply(host: Host): Promise<void> {
    return host.read(this.path).then(content => {
      const prefix = content.substring(0, this.pos);
      const suffix = content.substring(this.pos + this.oldText.length);
      const text = content.substring(this.pos, this.pos + this.oldText.length);

      if (text !== this.oldText) {
        return Promise.reject(
          new Error(`Invalid replace: "${text}" != "${this.oldText}".`)
        );
      }

      // TODO: throw error if oldText doesn't match removed string.
      return host.write(this.path, `${prefix}${this.newText}${suffix}`);
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

function addKarma(): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const karmaPath = "src/karma.conf.js";

    if (tree.exists(karmaPath)) {
      const karmaConfText = tree.read(karmaPath)!.toString("utf-8");
      const karmaConf = ts.createSourceFile(
        karmaPath,
        karmaConfText,
        ts.ScriptTarget.Latest,
        true
      );

      // context.logger.info(typeof karmaConf.statements[0]);

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

      const changes = [];

      let puppeteerDefined =
        getSourceNodes(karmaConf)
          .filter(node => {
            return node.kind === ts.SyntaxKind.ExpressionStatement;
          })
          .filter(node => {
            return (
              node
                .getText()
                .indexOf(
                  `process.env.CHROME_BIN = require("puppeteer").executablePath();`
                ) !== -1
            );
          }).length !== 0;

      context.logger.info(
        puppeteerDefined ? "Puppeteer is defined" : "Puppeteer is not defined"
      );

      if (!puppeteerDefined) {
        changes.push(
          new InsertChange(
            karmaPath,
            0,
            `process.env.CHROME_BIN = require("puppeteer").executablePath();\n`
          )
        );
      }

      let configName = "config";

      const configObj = getSourceNodes(karmaConf)
        .filter(node => {
          return (
            node.kind === ts.SyntaxKind.ExpressionStatement &&
            (node as ts.ExpressionStatement).expression.kind ===
              ts.SyntaxKind.BinaryExpression
          );
        })
        .map(node => {
          return (node as ts.ExpressionStatement)
            .expression as ts.BinaryExpression;
        })
        .filter(
          node =>
            (node.left as ts.PropertyAccessExpression).name.text === "exports"
        )
        .map(node => {
          configName = (node.right as ts.FunctionExpression).parameters[0].name.getText();
          return (((node.right as ts.FunctionExpression).body.statements.filter(
            statement => {
              return (
                (statement as ts.ExpressionStatement).expression.kind ===
                  ts.SyntaxKind.CallExpression &&
                ((statement as ts.ExpressionStatement)
                  .expression as ts.CallExpression).expression.kind ===
                  ts.SyntaxKind.PropertyAccessExpression &&
                (((statement as ts.ExpressionStatement)
                  .expression as ts.CallExpression)
                  .expression as ts.PropertyAccessExpression).expression.getText() ===
                  configName &&
                (((statement as ts.ExpressionStatement)
                  .expression as ts.CallExpression)
                  .expression as ts.PropertyAccessExpression).name.getText() ===
                  "set"
              );
            }
          )[0] as ts.ExpressionStatement).expression as ts.CallExpression)
            .arguments[0] as ts.ObjectLiteralExpression;
        })[0];

      // TODO: make sure karma-chrome-launcher is a plugin
      // not immediately needed because ng-cli uses karma-chrome-launcher by default
      // const plugins = configObj.properties.filter(prop => prop.name.getText() === 'plugins')[0];

      let pos = 0;

      // make sure browser is set to ChromeHeadless
      const browsers = configObj.properties.filter(
        prop => prop.name.getText() === "browsers"
      )[0];
      if (browsers) {
        if (
          ((browsers as ts.PropertyAssignment)
            .initializer as ts.ArrayLiteralExpression).elements.length > 1
        ) {
          // replace them all
          changes.push(
            new ReplaceChange(
              karmaPath,
              browsers.getStart(),
              browsers.getText(),
              `["Chrome"]`
            )
          );
          pos = browsers.getStart();
        } else {
          if (
            ((browsers as ts.PropertyAssignment)
              .initializer as ts.ArrayLiteralExpression).elements.length === 1
          ) {
            if (
              ((browsers as ts.PropertyAssignment)
                .initializer as ts.ArrayLiteralExpression).elements[0].getText() !==
              '"ChromeHeadless"'
            ) {
              changes.push(
                new ReplaceChange(
                  karmaPath,
                  ((browsers as ts.PropertyAssignment)
                    .initializer as ts.ArrayLiteralExpression).elements[0].getStart(),
                  ((browsers as ts.PropertyAssignment)
                    .initializer as ts.ArrayLiteralExpression).elements[0].getText(),
                  '"ChromeHeadless"'
                )
              );
              pos = ((browsers as ts.PropertyAssignment)
                .initializer as ts.ArrayLiteralExpression).elements[0].getStart();
            }
          }
        }
      }

      const recorder = tree.beginUpdate(karmaPath);

      for (const change of changes) {
        if (change instanceof InsertChange) {
          recorder.insertLeft(change.pos, change.toAdd);
        } else if (change instanceof ReplaceChange) {
          recorder.remove(pos, change.oldText.length);
          recorder.insertLeft(change.order, change.newText);
        }
      }
      tree.commitUpdate(recorder);

      return tree;
    }
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

      const changes = [];

      let puppeteerDefined =
        getSourceNodes(protractorConf)
          .filter(node => {
            return node.kind === ts.SyntaxKind.VariableStatement;
          })
          .map(
            node =>
              (node as ts.VariableStatement)
                .declarationList as ts.VariableDeclarationList
          )
          .filter(node => {
            return (
              node.declarations.filter(dec => {
                return (
                  (dec as ts.VariableDeclaration).name.getText() === "puppeteer"
                );
              }).length !== 0
            );
          }).length !== 0;

      context.logger.info(
        puppeteerDefined ? "Puppeteer is defined" : "Puppeteer is not defined"
      );

      if (!puppeteerDefined) {
        changes.push(
          new InsertChange(
            protractorPath,
            0,
            "var puppeteer = require('puppeteer');\n"
          )
        );
      }

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

      const capabilities: ts.ObjectLiteralExpression = (configNode as ts.ObjectLiteralExpression).properties
        .filter(prop => {
          return prop.name.getText() === "capabilities";
        })
        .map(prop => {
          return (prop as ts.PropertyAssignment)
            .initializer as ts.ObjectLiteralExpression;
        })[0];

      if (capabilities) {
        const browserName = capabilities.properties.filter(node => {
          return node.name.getText() === "browserName"; // && (node as ts.PropertyAssignment).initializer.getText() === 'chrome';
        })[0];
        if (browserName) {
          if (
            (browserName as ts.PropertyAssignment).initializer.getText() !==
            "chrome"
          ) {
            changes.push(
              new ReplaceChange(
                protractorPath,
                (browserName as ts.PropertyAssignment).initializer.getStart(),
                (browserName as ts.PropertyAssignment).initializer.getText(),
                "chrome"
              )
            );
          }
        } else {
          changes.push(
            new InsertChange(
              protractorPath,
              capabilities.getEnd() - 1,
              `, ${"browserName"}: "chrome"`
            )
          );
        }
        const chromeOptions = capabilities.properties.filter(node => {
          return node.name.getText() === "chromeOptions"; // && (node as ts.PropertyAssignment).initializer.getText() === 'chrome';
        })[0];
        if (chromeOptions) {
          if (
            (chromeOptions as ts.PropertyAssignment).initializer
              .getFullText()
              .indexOf("--headless") === -1
          ) {
            changes.push(
              new ReplaceChange(
                protractorPath,
                (chromeOptions as ts.PropertyAssignment).initializer.getStart(),
                (chromeOptions as ts.PropertyAssignment).initializer.getText(),
                "{args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}"
              )
            );
          }
        } else {
          changes.push(
            new InsertChange(
              protractorPath,
              capabilities.getEnd() - 1,
              `, ${"chromeOptions"}: {args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}`
            )
          );
        }
      } else {
        const expr = configNode as ts.ObjectLiteralExpression;
        let position: number;
        let toInsert: string;
        if (expr.properties.length == 0) {
          position = expr.getEnd() - 1;
          toInsert = `  capabilities: { browserName: "chrome", ${"chromeOptions"}: {args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}}\n`;
        } else {
          position = expr.properties[expr.properties.length - 1].getEnd();
          toInsert = `, capabilities: { browserName: "chrome", ${"chromeOptions"}: {args: ['--headless', '--no-sandbox', '--disable-dev-shm-usage'], binary: puppeteer.executablePath()}}`;
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

    // Create a single file. This is the simplest example of transforming the tree.
    // If a file with that name already exists, the generation will NOT fail until the tool
    // is trying to commit this to disk. This is because we allow you to work on what is
    // called a "staging" area, and only finalize those changes when the schematics is
    // done. This allows you to create files without having to verify if they exist
    // already, then rename them later. Templating works in a similar fashion.
    // tree.create('hello', 'world');

    return chain([
      options && options.skipPackageJson ? noop() : addPackages(),
      addProtractor(),
      addKarma()
    ])(tree, context);
  };
}
