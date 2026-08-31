import { runTemplate, type IWidget } from 'matrix-widget-api';

import type { RoomWidget } from './widget-content.js';

export interface WidgetTemplateVars {
  userId: string;
  roomId: string;
  displayName: string;
  avatarUrl: string;
  deviceId?: string;
  baseUrl?: string;
  clientTheme?: string;
  clientLanguage?: string;
}

export const WIDGET_CLIENT_ID = 'moe.sable.next';

export function templateWidgetUrl(widget: RoomWidget, vars: WidgetTemplateVars): string {
  const definition: IWidget = {
    id: widget.id,
    creatorUserId: vars.userId,
    type: widget.type,
    url: widget.url,
    name: widget.name,
    data: widget.data,
  };

  const resolved = runTemplate(widget.url, definition, {
    widgetRoomId: vars.roomId,
    currentUserId: vars.userId,
    userDisplayName: vars.displayName,
    userHttpAvatarUrl: vars.avatarUrl,
    clientId: WIDGET_CLIENT_ID,
    clientTheme: vars.clientTheme,
    clientLanguage: vars.clientLanguage,
    deviceId: vars.deviceId,
    baseUrl: vars.baseUrl,
  });

  try {
    const parsed = new URL(resolved);
    if (!parsed.searchParams.has('widgetId')) parsed.searchParams.set('widgetId', widget.id);
    return parsed.toString();
  } catch {
    return resolved;
  }
}
