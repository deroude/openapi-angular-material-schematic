/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { virtualFs, workspaces, strings } from '@angular-devkit/core';
import {
  Rule,
  Tree,
  apply,
  applyTemplates,
  chain,
  mergeWith,
  url,
  move,
  SchematicsException
} from '@angular-devkit/schematics';
import fs from 'fs';
import * as yaml from 'js-yaml';
import { OpenAPIV3 } from 'express-openapi-validator/dist/framework/types';
import { ProjectDefinition } from '@angular-devkit/core/src/workspace';

type PropType = 'number' | 'string' | 'boolean' | 'date' | 'enum';

const typeMap: { [k: string]: PropType } = {
  'string': 'string',
  'string:date': 'date',
  'string:date-time': 'date',
  'string:enum': 'enum',
  'integer': 'number',
  'integer:int32': 'number',
  'integer:int64': 'number',
  'number': 'number',
  'number:float': 'number',
  'number:double': 'number',
  'boolean': 'boolean'
}

interface Property {
  name: string;
  description?: string;
  type: PropType,
  isId: boolean;
  isRequired: boolean | undefined;
  enumOptions?: string[];
}

interface Entity {
  name: string;
  properties: Property[];
}

const defaultOptions: any = {
  style: 'scss',
  selectorPrefix: 'app'
}

export function loadEntities(api: OpenAPIV3.Document): Entity[] {
  const entities: Entity[] = [];
  if (api && api.components && api.components.schemas) {
    for (const [k, v] of Object.entries(api.components.schemas)) {
      const entity: Entity = { name: k, properties: [] };
      const schema: OpenAPIV3.SchemaObject = v as OpenAPIV3.SchemaObject;
      if (schema.properties) {
        for (const [pk, pv] of Object.entries(schema.properties)) {
          const p = pv as any;
          if (p.type) {
            entity.properties.push({
              name: pk,
              isId: pk.toLowerCase() === 'id',
              description: p.description,
              isRequired: schema.required && schema.required.indexOf(pk.toLowerCase()) > 0,
              type: typeMap[`${p.type}${p.format?`:${p.format}`:''}${p.enum?':enum':''}`],
              enumOptions: p.enum
            })
          }
        }
        entities.push(entity);
      }
    }
  }
  return entities;
}

// function addDeclarationToNgModule(options: any): Rule {
//   return (host: Tree) => {
//     if (options.skipImport || !options.module) {
//       return host;
//     }

//     const modulePath = options.module;
//     const source = readIntoSourceFile(host, modulePath);

//     const componentPath = `/${options.path}/`
//                           + (options.flat ? '' : strings.dasherize(options.name) + '/')
//                           + strings.dasherize(options.name)
//                           + (options.type ? '.' : '')
//                           + strings.dasherize(options.type);
//     const relativePath = buildRelativePath(modulePath, componentPath);
//     const classifiedName = strings.classify(options.name) + strings.classify(options.type);
//     const declarationChanges = addDeclarationToModule(source,
//                                                       modulePath,
//                                                       classifiedName,
//                                                       relativePath);

//     const declarationRecorder = host.beginUpdate(modulePath);
//     for (const change of declarationChanges) {
//       if (change instanceof InsertChange) {
//         declarationRecorder.insertLeft(change.pos, change.toAdd);
//       }
//     }
//     host.commitUpdate(declarationRecorder);

//     if (options.export) {
//       // Need to refresh the AST because we overwrote the file in the host.
//       const source = readIntoSourceFile(host, modulePath);

//       const exportRecorder = host.beginUpdate(modulePath);
//       const exportChanges = addExportToModule(source, modulePath,
//                                               strings.classify(options.name) + strings.classify(options.type),
//                                               relativePath);

//       for (const change of exportChanges) {
//         if (change instanceof InsertChange) {
//           exportRecorder.insertLeft(change.pos, change.toAdd);
//         }
//       }
//       host.commitUpdate(exportRecorder);
//     }

//     if (options.entryComponent) {
//       // Need to refresh the AST because we overwrote the file in the host.
//       const source = readIntoSourceFile(host, modulePath);

//       const entryComponentRecorder = host.beginUpdate(modulePath);
//       const entryComponentChanges = addEntryComponentToModule(
//         source, modulePath,
//         strings.classify(options.name) + strings.classify(options.type),
//         relativePath);

//       for (const change of entryComponentChanges) {
//         if (change instanceof InsertChange) {
//           entryComponentRecorder.insertLeft(change.pos, change.toAdd);
//         }
//       }
//       host.commitUpdate(entryComponentRecorder);
//     }


//     return host;
//   };
// }

async function loadApi(apiPath: string): Promise<OpenAPIV3.Document> {
  if (apiPath && fs.existsSync(apiPath)) {
    try {
      return Promise.resolve(yaml.load(fs.readFileSync(apiPath, 'utf-8')) as OpenAPIV3.Document);
    } catch (err) {
      console.error(`Unable to load API file from [${apiPath}]`);
      console.error(err);
      return Promise.reject(err);
    }
  }
  return Promise.reject(`API path invalid: ${apiPath}`);
}

function createHost(tree: Tree): workspaces.WorkspaceHost {
  return {
    async readFile(path: string): Promise<string> {
      const data = tree.read(path);
      if (!data) {
        throw new Error('File not found.');
      }

      return virtualFs.fileBufferToString(data);
    },
    async writeFile(path: string, data: string): Promise<void> {
      return tree.overwrite(path, data);
    },
    async isDirectory(path: string): Promise<boolean> {
      // approximate a directory check
      return !tree.exists(path) && tree.getDir(path).subfiles.length > 0;
    },
    async isFile(path: string): Promise<boolean> {
      return tree.exists(path);
    },
  };
}

async function getWorkspace(tree: Tree, path = '/') {
  const host = createHost(tree);

  const { workspace } = await workspaces.readWorkspace(path, host);

  return workspace;
}


export default function (options: any): Rule {
  return async (tree: Tree) => {

    let api: OpenAPIV3.Document
    try {
      api = await loadApi(options.api);
    } catch (err) {
      throw new SchematicsException(`Unable to load API file: ${err}`);
    }

    let project: ProjectDefinition | undefined;

    try {
      const workspace = await getWorkspace(tree);
      project = workspace.projects.get(options.project as string);
    } catch (err) { }

    let path = `${project ? project.sourceRoot : ''}/app/components`

    return chain(loadEntities(api).map(
      entity => {
        const templateSource = apply(url('./files'), [
          applyTemplates({ ...defaultOptions, ...options, ...entity, project, ...strings }),
          move(path)
        ]);
        return mergeWith(templateSource);
      }
    ));
  };
}