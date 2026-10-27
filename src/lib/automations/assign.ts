/**
 * Agent selection for the `assign_conversation` step in `round_robin`
 * mode. Stateless load balancing: the eligible member with the fewest
 * open assigned conversations wins, ties broken by user_id so the
 * outcome is deterministic. A conversation already held by an eligible
 * member stays with them, so a lead keeps the same salesperson across
 * repeated triggers.
 *
 * Viewers are read-only (they cannot reply), so they are never picked.
 */

export const ASSIGNABLE_ROLES = ['owner', 'admin', 'agent'] as const

export interface AssignableMember {
  user_id: string
  account_role: string
}

export function pickRoundRobinAgent(
  members: AssignableMember[],
  openAssignedAgentIds: (string | null)[],
  currentAgentId?: string | null,
): string | null {
  const eligible = members
    .filter((m) => (ASSIGNABLE_ROLES as readonly string[]).includes(m.account_role))
    .map((m) => m.user_id)
  if (eligible.length === 0) return null
  if (currentAgentId && eligible.includes(currentAgentId)) return currentAgentId

  const load = new Map<string, number>(eligible.map((id) => [id, 0]))
  for (const id of openAssignedAgentIds) {
    if (id && load.has(id)) load.set(id, (load.get(id) ?? 0) + 1)
  }
  return [...load.entries()].sort(
    ([a, la], [b, lb]) => la - lb || (a < b ? -1 : a > b ? 1 : 0),
  )[0][0]
}
