export function isAdmin(userId, adminIds) {
  if (userId === undefined || userId === null) return false;
  return adminIds.includes(Number(userId));
}
