/** Mock Google Workspace directory entries for dev / mock adapter. */
export interface WorkspaceDirectoryUser {
  email: string;
  displayName: string;
  googleSub?: string;
  suspended?: boolean;
}

export function listMockWorkspaceDirectory(domain: string): WorkspaceDirectoryUser[] {
  const normalized = domain.trim().toLowerCase();
  if (normalized === 'rebus.industries') {
    return [
      { email: 'alice@rebus.industries', displayName: 'Alice Dev', googleSub: 'google-sub-alice' },
      { email: 'bob@rebus.industries', displayName: 'Bob Viewer', googleSub: 'google-sub-bob' },
      { email: 'charlie@rebus.industries', displayName: 'Charlie Pending', googleSub: 'google-sub-charlie' },
    ];
  }
  return [
    { email: `admin@${normalized}`, displayName: 'Workspace Admin' },
    { email: `user@${normalized}`, displayName: 'Workspace User' },
  ];
}
