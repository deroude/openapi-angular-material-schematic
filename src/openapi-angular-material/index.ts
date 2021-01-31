/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { strings } from '@angular-devkit/core';
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
import { addDeclarationToModule } from '@schematics/angular/utility/ast-utils';
import fs from 'fs';
import * as yaml from 'js-yaml';
import { OpenAPIV3 } from 'express-openapi-validator/dist/framework/types';

import * as ts from 'typescript';
import { classify, dasherize } from '@angular-devkit/core/src/utils/strings';
import { InsertChange } from '@schematics/angular/utility/change';

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

function readIntoSourceFile(tree: Tree, modulePath: string): ts.SourceFile {
  const source = tree.read(modulePath);
  if (!source) {
    throw new SchematicsException(`File ${modulePath} does not exist.`);
  }
  const sourceText = source.toString('utf-8');
  return ts.createSourceFile(modulePath, sourceText, ts.ScriptTarget.Latest, true);
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
              type: typeMap[`${p.type}${p.format ? `:${p.format}` : ''}${p.enum ? ':enum' : ''}`],
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

function addDeclarationToNgModule(entity: string, options: any): Rule {
  return (host: Tree) => {
    const modulePath = options.module;
    try {
      const source = readIntoSourceFile(host, modulePath);
      if (!source) {
        throw new SchematicsException('Unable to find module');
      }
      const declarationRecorder = host.beginUpdate(modulePath);

      const listChanges = addDeclarationToModule(source, modulePath, `${classify(entity)}ListComponent`, `${options.path}/${dasherize(entity)}/list/${dasherize(entity)}-list.component`);
      for (const change of listChanges) {
        if (change instanceof InsertChange) {
          declarationRecorder.insertLeft(change.pos, change.toAdd);
        }
      }
      const editorChanges = addDeclarationToModule(source, modulePath, `${classify(entity)}EditorComponent`, `${options.path}/${dasherize(entity)}/form/${dasherize(entity)}-form.component`);
      for (const change of editorChanges) {
        if (change instanceof InsertChange) {
          declarationRecorder.insertLeft(change.pos, change.toAdd);
        }
      }
      host.commitUpdate(declarationRecorder);
    } catch (err) {
      console.error(err);
    }

    return host;
  };
}

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


export default function (options: any): Rule {
  return async () => {

    let api: OpenAPIV3.Document
    try {
      api = await loadApi(options.api);
    } catch (err) {
      throw new SchematicsException(`Unable to load API file: ${err}`);
    }

    let path = options.path || `src/app/components`;
    let module = options.module || `src/app/app.module.ts`;

    return chain(loadEntities(api).map(
      entity => {
        const templateSource = apply(url('./files'), [
          applyTemplates({ ...defaultOptions, ...options, ...entity, ...strings }),
          move(path),
          addDeclarationToNgModule(entity.name, { path, module, ...options })
        ]);
        return mergeWith(templateSource);
      }
    ));
  };
}