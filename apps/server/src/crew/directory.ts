/**
 * CrewDirectory over the users, groups, and group_members tables. A crew becomes active when
 * every member has confirmed; the creator counts as confirmed at creation.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  User as UserSchema,
  crewChatId,
  makeJoinCode,
  newId,
  normalizeJoinCode,
  type CrewDirectory,
  type Group,
  type User,
} from '@bubbleworks/shared';
import type { Db } from '../db/client.js';
import { groupMembers, groups, users } from '../db/schema.js';
import { groupById } from '../db/seed.js';

export class DbCrewDirectory implements CrewDirectory {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async userByHandle(handle: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.handle, handle)).get();
    return row ? UserSchema.parse(row) : null;
  }

  async userById(userId: string): Promise<User | null> {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    return row ? UserSchema.parse(row) : null;
  }

  async createUser(input: {
    displayName: string;
    handle: string;
    email?: string | null;
    bubbleNumber?: string | null;
  }): Promise<User> {
    const existing = await this.userByHandle(input.handle);
    if (existing) return existing;
    const row: typeof users.$inferInsert = {
      id: newId('user'),
      displayName: input.displayName,
      handle: input.handle,
      email: input.email ?? null,
      bubbleNumber: input.bubbleNumber ?? null,
      onboardedAt: null,
      timezone: 'America/New_York',
      createdAt: this.now().toISOString(),
    };
    this.db.insert(users).values(row).run();
    return UserSchema.parse(row);
  }

  async updateUser(
    userId: string,
    patch: Partial<Pick<User, 'displayName' | 'email' | 'bubbleNumber' | 'onboardedAt'>>,
  ): Promise<User> {
    if (Object.keys(patch).length > 0) {
      this.db.update(users).set(patch).where(eq(users.id, userId)).run();
    }
    const user = await this.userById(userId);
    if (!user) throw new Error(`user ${userId} not found`);
    return user;
  }

  async crewsOf(userId: string): Promise<Group[]> {
    const ids = this.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId))
      .all()
      .map((r) => r.groupId);
    return ids.map((id) => groupById(this.db, id)).filter((g): g is Group => g !== null);
  }

  async crewById(groupId: string): Promise<Group | null> {
    return groupById(this.db, groupId);
  }

  async crewByJoinCode(code: string): Promise<Group | null> {
    const row = this.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.joinCode, normalizeJoinCode(code)))
      .get();
    return row ? groupById(this.db, row.id) : null;
  }

  /** A code nobody else holds; the slug comes from the crew name, the digits are random. */
  private freshJoinCode(name: string): string {
    for (let i = 0; i < 20; i += 1) {
      const code = makeJoinCode(name);
      const taken = this.db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.joinCode, code))
        .get();
      if (!taken) return code;
    }
    return makeJoinCode(name, newId('code'));
  }

  async crewByChatId(chatId: string): Promise<Group | null> {
    const row = this.db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.chatId, chatId))
      .get();
    return row ? groupById(this.db, row.id) : null;
  }

  async membersOf(groupId: string): Promise<User[]> {
    const ids = this.db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .all()
      .map((r) => r.userId);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(users)
      .where(inArray(users.id, ids))
      .all()
      .map((r) => UserSchema.parse(r));
  }

  async createCrew(input: {
    name: string;
    createdByUserId: string;
    memberIds: string[];
  }): Promise<Group> {
    const now = this.now().toISOString();
    const id = newId('group');
    const ids = [...new Set([input.createdByUserId, ...input.memberIds])];
    this.db.transaction((tx) => {
      tx.insert(groups)
        .values({
          id,
          name: input.name,
          chatId: crewChatId(id),
          status: ids.length === 1 ? 'active' : 'pending',
          createdByUserId: input.createdByUserId,
          joinCode: this.freshJoinCode(input.name),
          centerLat: null,
          centerLng: null,
          timezone: 'America/New_York',
          createdAt: now,
        })
        .run();
      for (const userId of ids) {
        tx.insert(groupMembers)
          .values({
            groupId: id,
            userId,
            joinedAt: now,
            confirmedAt: userId === input.createdByUserId ? now : null,
          })
          .run();
      }
    });
    return this.mustGet(id);
  }

  async confirmMember(groupId: string, userId: string): Promise<Group> {
    const member = this.db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .get();
    if (!member) throw new Error(`${userId} is not in ${groupId}`);
    // Only the first confirmation sets the timestamp; repeats are no-ops.
    this.db
      .update(groupMembers)
      .set({ confirmedAt: this.now().toISOString() })
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, userId),
          isNull(groupMembers.confirmedAt),
        ),
      )
      .run();
    return this.refreshStatus(groupId);
  }

  async addMember(groupId: string, userId: string): Promise<Group> {
    this.db
      .insert(groupMembers)
      .values({ groupId, userId, joinedAt: this.now().toISOString(), confirmedAt: null })
      .onConflictDoNothing()
      .run();
    return this.refreshStatus(groupId);
  }

  async removeMember(groupId: string, userId: string): Promise<Group> {
    this.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
      .run();
    return this.refreshStatus(groupId);
  }

  private refreshStatus(groupId: string): Group {
    const rows = this.db
      .select({ confirmedAt: groupMembers.confirmedAt })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .all();
    const active = rows.length > 0 && rows.every((r) => r.confirmedAt !== null);
    this.db
      .update(groups)
      .set({ status: active ? 'active' : 'pending' })
      .where(eq(groups.id, groupId))
      .run();
    return this.mustGet(groupId);
  }

  private mustGet(groupId: string): Group {
    const g = groupById(this.db, groupId);
    if (!g) throw new Error(`crew ${groupId} not found`);
    return g;
  }
}
