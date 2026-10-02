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

const TEMPLATE_PARAMS = [
  'matrix_user_id=$matrix_user_id',
  'matrix_display_name=$matrix_display_name',
  'matrix_avatar_url=$matrix_avatar_url',
  'matrix_room_id=$matrix_room_id',
  'matrix_widget_id=$matrix_widget_id',
  'theme=$org.matrix.msc2873.client_theme',
  'matrix_client_id=$org.matrix.msc2873.client_id',
  'matrix_client_language=$org.matrix.msc2873.client_language',
  'matrix_device_id=$org.matrix.msc3819.matrix_device_id',
  'matrix_base_url=$org.matrix.msc4039.matrix_base_url',
].join('&');

export function enrichWidgetUrl(rawUrl: string): string {
  if (rawUrl.includes('$matrix_') || rawUrl.includes('$org.matrix.')) return rawUrl;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.hash.includes('?')) return `${rawUrl}&${TEMPLATE_PARAMS}`;
    if (parsed.hash) return `${rawUrl}?${TEMPLATE_PARAMS}`;
    return `${rawUrl}${parsed.search ? '&' : '?'}${TEMPLATE_PARAMS}`;
  } catch {
    return rawUrl;
  }
}
