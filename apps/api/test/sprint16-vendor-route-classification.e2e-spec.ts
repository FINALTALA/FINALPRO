import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import {
  BLOCK_WHEN_SUSPENDED_KEY,
  VendorSuspendedGuard,
} from './../src/auth/vendor-suspended.guard';
import {
  SUSPENDED_ALLOW_ROUTES,
  SUSPENDED_DENY_ROUTES,
} from './../src/auth/vendor-route-classification';
import { Sprint16Ctx, bootApp } from './helpers/sprint16-fixtures';

const joinPath = (...parts: (string | string[] | undefined)[]) =>
  parts
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p !== '')
    .join('/');

// Sprint 16 (L-23): every route under `vendors/:vendorId/*` MUST have an
// explicit decision for a SUSPENDED vendor. This reads the routes that
// are actually registered in the running Nest app - not a hand-kept
// list - so a route added in any later sprint without a classification
// fails here instead of silently being open (or closed) to a suspended
// store.
describe('Sprint 16 - vendor route classification for SUSPENDED stores (e2e)', () => {
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
          Reflect.getMetadata(BLOCK_WHEN_SUSPENDED_KEY, metatype) === true;
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
          if (!path.startsWith('vendors/:vendorId')) continue;
          registered.push({
            key: `${RequestMethod[method]} ${path}`,
            blocked:
              Reflect.getMetadata(BLOCK_WHEN_SUSPENDED_KEY, handler) === true ||
              classBlocked,
            hasGuard: [...classGuards, ...methodGuards].includes(
              VendorSuspendedGuard,
            ),
          });
        }
      }
    }
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('discovers the vendor-scoped routes (sanity: the scan itself works)', () => {
    expect(registered.length).toBeGreaterThan(50);
    expect(registered.map((r) => r.key)).toContain(
      'POST vendors/:vendorId/offers',
    );
  });

  it('classifies every registered vendors/:vendorId/* route exactly once - an unclassified route (a new endpoint with no suspension decision) fails here', () => {
    const deny = new Set(SUSPENDED_DENY_ROUTES);
    const allow = new Set(SUSPENDED_ALLOW_ROUTES);
    const unclassified = registered
      .map((r) => r.key)
      .filter((k) => !deny.has(k) && !allow.has(k));
    expect(unclassified).toEqual([]);
    const both = [...deny].filter((k) => allow.has(k));
    expect(both).toEqual([]);
  });

  it('has no stale classification entries for routes that no longer exist', () => {
    const keys = new Set(registered.map((r) => r.key));
    expect(SUSPENDED_DENY_ROUTES.filter((k) => !keys.has(k))).toEqual([]);
    expect(SUSPENDED_ALLOW_ROUTES.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every DENY route is actually guarded, and no ALLOW route is', () => {
    const deny = new Set(SUSPENDED_DENY_ROUTES);
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
