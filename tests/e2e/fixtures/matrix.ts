export type RoomOptions = {
  name?: string;
  topic?: string;
  preset?: 'private_chat' | 'public_chat' | 'trusted_private_chat';
  visibility?: 'private' | 'public';
  invite?: string[];
  powerLevels?: Record<string, unknown>;
  isSpace?: boolean;
};

export class MatrixAdmin {
  constructor(
    readonly baseUrl: string,
    readonly accessToken: string,
    readonly userId: string
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/_matrix/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `${method} ${path} as ${this.userId} failed: ${String(response.status)} ${await response.text()} — sent ${JSON.stringify(body).slice(0, 300)}`
      );
    }
    return (await response.json()) as T;
  }

  async createRoom(options: RoomOptions = {}): Promise<string> {
    const {
      name,
      topic,
      preset = 'private_chat',
      visibility = 'private',
      invite,
      powerLevels,
      isSpace = false,
    } = options;
    const { room_id: roomId } = await this.request<{ room_id: string }>(
      'POST',
      `client/v3/createRoom`,
      {
        name,
        topic,
        preset,
        visibility,
        invite,
        power_level_content_override: powerLevels,
        creation_content: isSpace ? { type: 'm.space' } : undefined,
      }
    );
    return roomId;
  }

  private get serverName(): string {
    return this.userId.split(':').slice(1).join(':');
  }

  addSpaceChild(
    spaceId: string,
    childId: string,
    { order, suggested = false }: { order?: string; suggested?: boolean } = {}
  ): Promise<string> {
    return this.sendStateEvent(spaceId, 'm.space.child', childId, {
      via: [this.serverName],
      order,
      suggested,
    });
  }

  spaceChild(spaceId: string, childId: string): Promise<{ order?: string; via?: string[] }> {
    return this.request<{ order?: string; via?: string[] }>(
      'GET',
      `client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`
    );
  }

  async sendEvent(
    roomId: string,
    eventType: string,
    content: unknown,
    transactionId = `e2e-${String(Date.now())}-${String(Math.random()).slice(2)}`
  ): Promise<string> {
    const { event_id: eventId } = await this.request<{ event_id: string }>(
      'PUT',
      `client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(transactionId)}`,
      content
    );
    return eventId;
  }

  sendMessage(roomId: string, body: string, extra: Record<string, unknown> = {}): Promise<string> {
    return this.sendEvent(roomId, 'm.room.message', { msgtype: 'm.text', body, ...extra });
  }

  async sendStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: unknown
  ): Promise<string> {
    const { event_id: eventId } = await this.request<{ event_id: string }>(
      'PUT',
      `client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`,
      content
    );
    return eventId;
  }

  createPoll(
    roomId: string,
    question: string,
    answers: string[],
    options: { undisclosed?: boolean; maxSelections?: number } = {}
  ): Promise<string> {
    const { undisclosed = false, maxSelections = 1 } = options;
    return this.sendEvent(roomId, 'org.matrix.msc3381.poll.start', {
      'org.matrix.msc1767.text': question,
      'org.matrix.msc3381.poll.start': {
        kind: undisclosed
          ? 'org.matrix.msc3381.poll.undisclosed'
          : 'org.matrix.msc3381.poll.disclosed',
        max_selections: maxSelections,
        question: { 'org.matrix.msc1767.text': question },
        answers: answers.map((answer, index) => ({
          id: `answer-${String(index)}`,
          'org.matrix.msc1767.text': answer,
        })),
      },
    });
  }

  votePoll(roomId: string, pollId: string, answerIds: string[]): Promise<string> {
    return this.sendEvent(roomId, 'org.matrix.msc3381.poll.response', {
      'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
      'org.matrix.msc3381.poll.response': { answers: answerIds },
    });
  }

  editMessage(roomId: string, eventId: string, body: string): Promise<string> {
    return this.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    });
  }

  async redact(roomId: string, eventId: string, reason?: string): Promise<string> {
    const { event_id: redaction } = await this.request<{ event_id: string }>(
      'PUT',
      `client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/r-${String(Date.now())}-${String(Math.random()).slice(2)}`,
      { reason }
    );
    return redaction;
  }

  async uploadMedia(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': mime },
        body: bytes as unknown as BodyInit,
      }
    );
    if (!response.ok) {
      throw new Error(`upload failed: ${String(response.status)} ${await response.text()}`);
    }
    const { content_uri: uri } = (await response.json()) as { content_uri?: string };
    if (!uri) throw new Error('upload response carried no content_uri');
    return uri;
  }

  sendImage(
    roomId: string,
    url: string,
    {
      body = 'image.png',
      mime = 'image/png',
      width,
      height,
      size,
    }: {
      body?: string;
      mime?: string;
      width?: number;
      height?: number;
      size?: number;
    } = {}
  ): Promise<string> {
    return this.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.image',
      body,
      url,
      info: { mimetype: mime, w: width, h: height, size },
    });
  }

  setWidget(roomId: string, stateKey: string, content: unknown): Promise<string> {
    return this.sendStateEvent(roomId, 'im.vector.modular.widgets', stateKey, content);
  }

  setDisplayName(displayname: string): Promise<unknown> {
    return this.request('PUT', `client/v3/profile/${encodeURIComponent(this.userId)}/displayname`, {
      displayname,
    });
  }

  profile(userId = this.userId): Promise<{ displayname?: string }> {
    return this.request<{ displayname?: string }>(
      'GET',
      `client/v3/profile/${encodeURIComponent(userId)}`
    );
  }

  pushRules(): Promise<{ global: { content?: { rule_id: string }[] } }> {
    return this.request<{ global: { content?: { rule_id: string }[] } }>(
      'GET',
      'client/v3/pushrules/'
    );
  }

  invite(roomId: string, userId: string): Promise<unknown> {
    return this.request('POST', `client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      user_id: userId,
    });
  }

  async roomsByName(): Promise<Map<string, string>> {
    const { joined_rooms: rooms } = await this.request<{ joined_rooms: string[] }>(
      'GET',
      'client/v3/joined_rooms'
    );
    const named = new Map<string, string>();
    for (const roomId of rooms) {
      const name = await this.request<{ name?: string }>(
        'GET',
        `client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`
      )
        .then((state) => state.name)
        .catch(() => undefined);
      if (name !== undefined && !named.has(name)) named.set(name, roomId);
    }
    return named;
  }

  join(roomId: string): Promise<unknown> {
    return this.request('POST', `client/v3/rooms/${encodeURIComponent(roomId)}/join`, {});
  }

  async upgradeRoom(roomId: string, newVersion = '11'): Promise<string> {
    const { replacement_room: replacement } = await this.request<{ replacement_room: string }>(
      'POST',
      `client/v3/rooms/${encodeURIComponent(roomId)}/upgrade`,
      { new_version: newVersion }
    );
    return replacement;
  }
}
