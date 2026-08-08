/**
 * The per-role task detail a client captures on the Targeting step, stored as
 * Campaign.roleConfig (snake_case keys, as sent by the client).
 */
export type RoleConfig = {
  content_type?: string;
  task_mode?: string; // 'ONLINE' | 'OFFLINE'
  task_types?: string[];
  budget_bucket?: string;
  following_size?: string;
  audience_reach?: string;
};

/** Coerce an untyped JSON value (Prisma Json) into a RoleConfig, or null. */
export function asRoleConfig(value: unknown): RoleConfig | null {
  if (!value || typeof value !== 'object') return null;
  return value as RoleConfig;
}

/**
 * A short, human-readable "what to do" line for a given role + config, shown to
 * promoters (on their assignment) and admins (on campaign review). Falls back to
 * a sensible default when the client left the detail blank.
 */
export function describeRoleTask(role: string, cfg: RoleConfig | null): string {
  switch (role) {
    case 'CREATOR':
      return cfg?.content_type
        ? `Create original content — ${cfg.content_type}.`
        : 'Create original content about this product from the brief and assets.';
    case 'PARTICIPATOR': {
      const mode = cfg?.task_mode === 'OFFLINE' ? 'offline' : 'online';
      const tasks = cfg?.task_types?.length ? cfg.task_types.join('; ') : 'a set task the client assigned';
      return `Complete an ${mode} task: ${tasks}.`;
    }
    case 'INFLUENCER': {
      const bits = [cfg?.following_size ? `following ${cfg.following_size}` : null, cfg?.budget_bucket ? `budget ${cfg.budget_bucket}` : null].filter(Boolean);
      return `Collaborative feature post${bits.length ? ` — ${bits.join(' · ')}` : ''}.`;
    }
    case 'DISTRIBUTOR':
    default:
      return 'Post the campaign to your channel exactly as provided.';
  }
}
