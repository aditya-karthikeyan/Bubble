/**
 * FakeCrewDirectory: in-memory people and crews, preloaded with the five personas and the demo
 * crew. Same semantics as the server implementation: a crew is pending until every member has
 * confirmed, and the creator counts as confirmed.
 */
import { makeJoinCode, normalizeJoinCode } from '../join-code.js';
import type { CrewDirectory } from '../ports.js';
import { crewChatId, type Group, type GroupMember, type User } from '../types.js';
import { DEMO_GROUP, DEMO_MEMBERS, PERSONAS } from './personas.js';

export class FakeCrewDirectory implements CrewDirectory {
  private readonly users = new Map<string, User>();
  private readonly crews = new Map<string, Group>();
  private readonly members = new Map<string, GroupMember[]>();
  private counter = 0;

  constructor(
    users: User[] = PERSONAS,
    crews: Array<{ group: Group; members: GroupMember[] }> = [
      { group: DEMO_GROUP, members: DEMO_MEMBERS },
    ],
  ) {
    for (const u of users) this.users.set(u.id, { ...u });
    for (const c of crews) {
      this.crews.set(c.group.id, { ...c.group });
      this.members.set(
        c.group.id,
        c.members.map((m) => ({ ...m })),
      );
    }
  }

  async userByHandle(handle: string): Promise<User | null> {
    return [...this.users.values()].find((u) => u.handle === handle) ?? null;
  }

  async userById(userId: string): Promise<User | null> {
    return this.users.get(userId) ?? null;
  }

  async createUser(input: {
    displayName: string;
    handle: string;
    email?: string | null;
    bubbleNumber?: string | null;
  }): Promise<User> {
    const existing = await this.userByHandle(input.handle);
    if (existing) return existing;
    this.counter += 1;
    const user: User = {
      id: `user_fake_${this.counter}`,
      displayName: input.displayName,
      handle: input.handle,
      email: input.email ?? null,
      bubbleNumber: input.bubbleNumber ?? null,
      onboardedAt: null,
      timezone: 'America/New_York',
      createdAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(
    userId: string,
    patch: Partial<Pick<User, 'displayName' | 'email' | 'bubbleNumber' | 'onboardedAt'>>,
  ): Promise<User> {
    const user = this.users.get(userId);
    if (!user) throw new Error(`FakeCrewDirectory: unknown user ${userId}`);
    const next = { ...user, ...patch };
    this.users.set(userId, next);
    return next;
  }

  async crewsOf(userId: string): Promise<Group[]> {
    return [...this.members.entries()]
      .filter(([, ms]) => ms.some((m) => m.userId === userId))
      .map(([id]) => this.crews.get(id)!)
      .filter(Boolean);
  }

  async crewById(groupId: string): Promise<Group | null> {
    return this.crews.get(groupId) ?? null;
  }

  async crewByChatId(chatId: string): Promise<Group | null> {
    return [...this.crews.values()].find((c) => c.chatId === chatId) ?? null;
  }

  async crewByJoinCode(code: string): Promise<Group | null> {
    const want = normalizeJoinCode(code);
    return [...this.crews.values()].find((c) => c.joinCode === want) ?? null;
  }

  async membersOf(groupId: string): Promise<User[]> {
    return (this.members.get(groupId) ?? [])
      .map((m) => this.users.get(m.userId))
      .filter((u): u is User => Boolean(u));
  }

  async createCrew(input: {
    name: string;
    createdByUserId: string;
    memberIds: string[];
  }): Promise<Group> {
    this.counter += 1;
    const now = new Date().toISOString();
    const id = `group_fake_${this.counter}`;
    const ids = [...new Set([input.createdByUserId, ...input.memberIds])];
    const group: Group = {
      id,
      name: input.name,
      chatId: crewChatId(id),
      status: ids.length === 1 ? 'active' : 'pending',
      createdByUserId: input.createdByUserId,
      joinCode: makeJoinCode(input.name, id),
      center: null,
      timezone: 'America/New_York',
      createdAt: now,
    };
    this.crews.set(id, group);
    this.members.set(
      id,
      ids.map((userId) => ({
        groupId: id,
        userId,
        joinedAt: now,
        confirmedAt: userId === input.createdByUserId ? now : null,
      })),
    );
    return group;
  }

  async confirmMember(groupId: string, userId: string): Promise<Group> {
    const ms = this.members.get(groupId);
    const m = ms?.find((x) => x.userId === userId);
    if (!ms || !m) throw new Error(`FakeCrewDirectory: ${userId} is not in ${groupId}`);
    m.confirmedAt ??= new Date().toISOString();
    return this.refreshStatus(groupId);
  }

  async addMember(groupId: string, userId: string): Promise<Group> {
    const ms = this.members.get(groupId);
    if (!ms) throw new Error(`FakeCrewDirectory: unknown crew ${groupId}`);
    if (!ms.some((m) => m.userId === userId)) {
      ms.push({ groupId, userId, joinedAt: new Date().toISOString(), confirmedAt: null });
    }
    return this.refreshStatus(groupId);
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    const ms = this.members.get(groupId);
    if (!ms) throw new Error(`FakeCrewDirectory: unknown crew ${groupId}`);
    this.members.set(
      groupId,
      ms.filter((m) => m.userId !== userId),
    );
    return this.refreshStatus(groupId);
  }

  private refreshStatus(groupId: string): Group {
    const group = this.crews.get(groupId);
    if (!group) throw new Error(`FakeCrewDirectory: unknown crew ${groupId}`);
    const ms = this.members.get(groupId) ?? [];
    const next: Group = {
      ...group,
      status: ms.length > 0 && ms.every((m) => m.confirmedAt) ? 'active' : 'pending',
    };
    this.crews.set(groupId, next);
    return next;
  }
}
