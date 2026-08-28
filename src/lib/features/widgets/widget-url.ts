export interface WidgetTemplateVars {
  userId: string;
  roomId: string;
  displayName: string;
  avatarUrl: string;
  widgetId: string;
}

export function templateWidgetUrl(url: string, vars: WidgetTemplateVars): string {
  const resolved = url
    .replaceAll('$matrix_user_id', encodeURIComponent(vars.userId))
    .replaceAll('$matrix_room_id', encodeURIComponent(vars.roomId))
    .replaceAll('$matrix_display_name', encodeURIComponent(vars.displayName))
    .replaceAll('$matrix_avatar_url', encodeURIComponent(vars.avatarUrl))
    .replaceAll('$matrix_widget_id', encodeURIComponent(vars.widgetId));

  try {
    const parsed = new URL(resolved);
    if (!parsed.searchParams.has('widgetId')) parsed.searchParams.set('widgetId', vars.widgetId);
    return parsed.toString();
  } catch {
    return resolved;
  }
}
