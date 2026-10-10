// What the Worker's classes extend, reduced to what they use from it.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
