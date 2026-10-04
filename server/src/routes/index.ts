// Route modules registered by the process entry (server/src/index.ts), in order.
// Each registrar adds its /api routes to the app; /api/health and /api/logs live in app.ts.
import type { RouteRegistrar } from '../app.ts';
import { workbenchRoutes } from './workbench.ts';
import { agentRoutes } from './agent.ts';

export const routeRegistrars: RouteRegistrar[] = [workbenchRoutes, agentRoutes()];
