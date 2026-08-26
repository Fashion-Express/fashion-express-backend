/**
 * The signed-in staff member, as every guard and controller sees them.
 *
 * BR-56 — privilege is read from the user's *type*, never from a column on the
 * account. `isSuperuser` and `isManager` below are the type's, resolved by
 * joining; there is no flag on `users` that could contradict them.
 *
 * FR-00.4.1 — the type and the permission set are different things and both are
 * here. The type answers *what is this person*; the permissions answer *what may
 * they do*.
 */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;

  /** The user type (FR-12.1). */
  userTypeId: string;
  userTypeCode: string;
  isSuperuser: boolean;
  isManager: boolean;

  /** §10.1 option B — defaults the shop on create forms (BR-55). May be null. */
  shopId: string | null;

  /** Permission codenames granted by the type (§10.3 option B). */
  permissions: ReadonlySet<string>;
}

/**
 * Does this user hold a capability?
 *
 * An unrestricted type short-circuits: FR-12.1.2 says the type declares whether
 * holders have unrestricted access, and "unrestricted" has to mean it without
 * needing every permission listed against it.
 */
export function can(user: AuthUser, codename: string): boolean {
  return user.isSuperuser || user.permissions.has(codename);
}
