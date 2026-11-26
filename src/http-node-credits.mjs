// Only billing metadata crosses the authenticated node boundary. Official
// AuthService still owns all upstream requests, caching and authentication.
function number(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function date(value) {
  const millis = number(value);
  return millis !== null && millis > 0 && millis < 253402300800000 ? new Date(millis).toISOString() : null;
}
const text = value => typeof value === 'string' ? value.slice(0, 200) : null;
const flag = value => typeof value === 'boolean' ? value : null;

export function officialCredits(usage, checkedAt) {
  const size = number(usage?.usageTotal), used = number(usage?.usageUsed), remain = number(usage?.usageLeft);
  if (size === null || size < 0 || used === null || used < 0 || remain === null
      || !Array.isArray(usage?.resources) || usage.resources.length > 1000) return null;
  const packages = [];
  for (const item of usage.resources) {
    const total = number(item?.total), consumed = number(item?.used), left = number(item?.left);
    if (total === null || total < 0 || consumed === null || consumed < 0 || left === null) return null;
    packages.push({name:text(item.name), package_code:text(item.packageCode), resource_id:text(item.id),
      size:total, used:consumed, remain:left, starts_at:date(item.startAt), expires_at:date(item.expireAt),
      refreshes_at:date(item.refreshAt), show_expire_at:flag(item.showExpireAt), show_refresh_at:flag(item.showRefreshAt)});
  }
  return {schema:'workbaby.credits/v1', source:'official-auth-service', checked_at:checkedAt,
    size, used, remain, subscription:{name:text(usage.name), edition:text(usage.editionType),
      paid:flag(usage.isPro), expires_at:date(usage.expireAt), refreshes_at:date(usage.refreshAt)}, packages};
}
