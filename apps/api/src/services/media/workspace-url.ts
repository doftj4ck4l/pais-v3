export function workspaceFileUrl(workspaceId: string, relativePath: string): string {
  const encoded = relativePath.split(/[\\/]/).map(encodePathSegment).join("/");
  return `/api/workspace/files/${encoded}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
