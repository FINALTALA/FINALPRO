import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import {
  BLOCK_WHEN_BRANCH_ARCHIVED_KEY,
  BranchArchivedGuard,
} from './../src/auth/branch-archived.guard';
import {
  BRANCH_ARCHIVED_ALLOW_ROUTES,
  BRANCH_ARCHIVED_DENY_ROUTES,
} from './../src/auth/branch-archived-route-classification';
import { Sprint16Ctx, bootApp } from './helpers/sprint16-fixtures';

const joinPath = (...parts: (string | string[] | undefined)[]) =>
  parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');

// Sprint 18b (G-ON-07): every route with a `:branchId` path param MUST
// have an explicit decision for an ARCHIVED branch. Same reflection-
// based discovery as sprint16-vendor-route-classification.e2e-spec.ts
// - reads the routes actually registered in the running Nest app, not
// a hand-kept list, so a route added in any later sprint with a
// `:branchId` param and no classification fails here instead of
// silently being open (or closed) to an archived branch.
describe('Sprint 18b - branch-archived route classification (e2e)', () => {
  const ctx = {} as Sprint16Ctx;
  let registered: {
    key: string;
    blocked: boolean;
    hasGuard: boolean;
  }[];

  beforeAll(async () => {
    await bootApp(ctx);
    const app: INestApplication = ctx.app;
    const container = app.get(ModulesContainer);
    registered = [];
    for (const module of container.values()) {
      for (const wrapper of module.controllers.values()) {
        const metatype = wrapper.metatype as
          (new (...a: never[]) => object) | null;
        if (!metatype) continue;
        const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) as
          string | string[] | undefined;
        const classBlocked =
          Reflect.getMetadata(BLOCK_WHEN_BRANCH_ARCHIVED_KEY, metatype) ===
          true;
        const classGuards =
          (Reflect.getMetadata(GUARDS_METADATA, metatype) as unknown[]) ?? [];
        for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
          if (name === 'constructor') continue;
          const handler = (metatype.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as
            RequestMethod | undefined;
          if (method === undefined) continue;
          const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as
            string | string[] | undefined;
          const methodGuards =
            (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? [];
          const path = joinPath(controllerPath, handlerPath);
          // Scope: ONLY routes with a :branchId path param - a route
          // like POST vendors/:vendorId/staff/:vendorUserId/transfer
          // checks its target branch from the request body, inline in
          // its own handler, and is deliberately out of scope here.
          if (!path.includes(':branchId')) continue;
          registered.push({
            key: `${RequestMethod[method]} ${path}`,
            blocked:
              Reflect.getMetadata(BLOCK_WHEN_BRANCH_ARCHIVED_KEY, handler) ===
                true || classBlocked,
            hasGuard: [...classGuards, ...methodGuards].includes(
              BranchArchivedGuard,
            ),
          });
        }
      }
    }
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('discovers the :branchId-scoped routes (sanity: the scan itself works)', () => {
    expect(registered.length).toBeGreaterThan(15);
    expect(registered.map((r) => r.key)).toContain(
      'POST vendors/:vendorId/branches/:branchId/archive',
    );
  });

  it('classifies every registered :branchId route exactly once - an unclassified route (a new endpoint with no archived-branch decision) fails here', () => {
    const deny = new Set(BRANCH_ARCHIVED_DENY_ROUTES);
    const allow = new Set(BRANCH_ARCHIVED_ALLOW_ROUTES);
    const unclassified = registered
      .map((r) => r.key)
      .filter((k) => !deny.has(k) && !allow.has(k));
    expect(unclassified).toEqual([]);
    const both = [...deny].filter((k) => allow.has(k));
    expect(both).toEqual([]);
  });

  it('has no stale classification entries for routes that no longer exist', () => {
    const keys = new Set(registered.map((r) => r.key));
    expect(BRANCH_ARCHIVED_DENY_ROUTES.filter((k) => !keys.has(k))).toEqual([]);
    expect(BRANCH_ARCHIVED_ALLOW_ROUTES.filter((k) => !keys.has(k))).toEqual(
      [],
    );
  });

  it('every DENY route is actually guarded, and no ALLOW route is', () => {
    const deny = new Set(BRANCH_ARCHIVED_DENY_ROUTES);
    const wronglyOpen = registered
      .filter((r) => deny.has(r.key) && !(r.blocked && r.hasGuard))
      .map((r) => r.key);
    expect(wronglyOpen).toEqual([]);
    const wronglyBlocked = registered
      .filter((r) => !deny.has(r.key) && (r.blocked || r.hasGuard))
      .map((r) => r.key);
    expect(wronglyBlocked).toEqual([]);
  });
});
