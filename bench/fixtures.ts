import type { EntityDefinition } from "../src/types";

/**
 * Shared shapes for the benchmark suite. Kept in one file so every arm is
 * measured against the SAME data — a benchmark whose arms differ in their input
 * is measuring the input.
 */

export const entityDefs: Record<string, EntityDefinition> = {
  User: { entityType: "User", idField: "id" },
  Post: { entityType: "Post", idField: "id" },
  Comment: { entityType: "Comment", idField: "id" },
};

/** A realistic nested API response: posts, each with an author and comments. */
export function feedPayload(postCount: number, commentsPerPost: number) {
  return {
    posts: Array.from({ length: postCount }, (_, p) => ({
      __typename: "Post",
      id: `p${p}`,
      title: `Post number ${p}`,
      body: "x".repeat(200),
      author: {
        __typename: "User",
        id: `u${p % 25}`, // 25 authors shared across all posts — the dedupe case
        name: `Author ${p % 25}`,
        avatar: `https://example.invalid/a/${p % 25}.png`,
      },
      comments: Array.from({ length: commentsPerPost }, (_, c) => ({
        __typename: "Comment",
        id: `p${p}c${c}`,
        text: `Comment ${c} on post ${p}`,
        author: {
          __typename: "User",
          id: `u${(p + c) % 25}`,
          name: `Author ${(p + c) % 25}`,
          avatar: `https://example.invalid/a/${(p + c) % 25}.png`,
        },
      })),
    })),
  };
}

export function userRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    entityType: "User",
    id: `u${i}`,
    data: { id: `u${i}`, name: `Author ${i}`, avatar: `https://example.invalid/a/${i}.png` },
  }));
}
