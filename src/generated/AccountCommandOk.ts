export type AccountCommandOk =
  | { type: 'set_profile_field' }
  | { type: 'account_contacts'; emails: string[] }
  | { type: 'ignored_users'; users: string[] };
