const userIdOf = (user) => user?.id || user?.user_id || null;

export const checkCapability = (user, capability, state = {}) => {
  const userId = userIdOf(user);
  if (!userId || !capability) return false;
  if (userId === state.leagueOwnerId) return true;
  const exceptions = state.authzExceptions?.[userId] || {};
  if (exceptions[capability] === "DENY") return false;
  if (exceptions[capability] === "ALLOW") return true;
  const roleIds = (state.authzUserRoles || []).filter((r) => r.user_id === userId).map((r) => r.role_id);
  return (state.authzRoleCapabilities || []).some((r) => roleIds.includes(r.role_id) && r.capability_id === capability);
};

export const checkOutranks = (actor, target, state = {}) => {
  const actorId = userIdOf(actor);
  const targetId = userIdOf(target);
  if (!actorId || !targetId) return false;
  if (actorId === state.leagueOwnerId) return true;
  const rank = (id) => Math.max(0, ...(state.authzUserRoles || []).filter((a) => a.user_id === id)
    .map((a) => (state.authzRoles || []).find((r) => r.id === a.role_id)?.rank || 0));
  return rank(actorId) > rank(targetId);
};

export const describeCapability = (user, capability, state = {}) => {
  const userId = userIdOf(user);
  if (!userId || !capability) return { allowed: false, source: "No signed-in account" };
  if (userId === state.leagueOwnerId) return { allowed: true, source: "League owner" };
  const exception = state.authzExceptions?.[userId]?.[capability];
  if (exception === "DENY") return { allowed: false, source: "Individual deny" };
  if (exception === "ALLOW") return { allowed: true, source: "Individual allow" };
  const grant = (state.authzRoleCapabilities || []).find((r) =>
    r.capability_id === capability && (state.authzUserRoles || []).some((u) => u.user_id === userId && u.role_id === r.role_id),
  );
  const role = grant && (state.authzRoles || []).find((r) => r.id === grant.role_id);
  return role
    ? { allowed: true, source: role.name }
    : { allowed: false, source: "No assigned role grants this" };
};
