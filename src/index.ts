import "dotenv/config";

import {
  connectToDatabase,
  disconnectFromDatabase,
  queryDatabase,
} from "./database";
import { Connection, ResultSetHeader } from "mysql2/promise";
import * as cheerio from "cheerio";
import { Element } from "domhandler";
import { logger } from "./logger";
import {
  formatDate,
  getLastProcessedDate,
  setLastProcessedDate,
} from "./utils";

const UPDATE_REGEX = /\[UPDATE(?:\s*\d*)?(?::\s*(.+?))?\]/gi;

async function main() {
  if (!process.env.USER_ID) {
    logger.error("USER_ID is not set in the environment variables.");
    return;
  }

  if (!process.env.USER_NAME) {
    logger.error("USER_NAME is not set in the environment variables.");
    return;
  }

  const connection = await connectToDatabase();
  if (!connection) {
    logger.error("Failed to connect to the database.");
    return;
  }

  const lastCreated = await getLastProcessedDate();
  if (!lastCreated) {
    logger.info("No last created date found. Exiting.");
    return;
  }

  await processPost(connection, lastCreated);

  await disconnectFromDatabase(connection);
}

main();

async function getNextPost(connection: Connection, created: string) {
  const res = await queryDatabase(
    connection,
    `SELECT * FROM jos_content
   WHERE created > ?
   AND \`fulltext\` LIKE ?
   ORDER BY created ASC
   LIMIT 1`,
    [created, "%forum topic%"]
  );

  if (!res || res.length === 0) return;

  return res[0];
}

async function insertMessage(
  connection: Connection,
  data: {
    parentId: number;
    threadId: number;
    categoryId: number;
    subject: string;
    message: string;
    userId: number;
    name: string;
    created: string;
    imageURL: string;
  }
) {
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    await connection.beginTransaction();

    // Insert into jos_kunena_messages
    const res = (await queryDatabase(
      connection,
      `INSERT INTO jos_kunena_messages
       (parent, thread, catid, subject, userid, name, time, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.parentId,
        data.threadId,
        data.categoryId,
        data.subject,
        data.userId,
        data.name,
        timestamp,
        "162.158.210.219",
      ]
    )) as unknown as ResultSetHeader;

    if (!res || res.affectedRows === 0)
      throw new Error("Message insert failed");

    const messageId = res.insertId;

    // Insert into jos_kunena_messages_text
    const res2 = (await queryDatabase(
      connection,
      `INSERT INTO jos_kunena_messages_text (mesid, message) VALUES (?, ?)`,
      [messageId, data.message]
    )) as unknown as ResultSetHeader;

    if (!res2 || res2.affectedRows === 0)
      throw new Error("Message text insert failed");

    // Update user post count
    const res3 = (await queryDatabase(
      connection,
      `UPDATE jos_kunena_users SET posts = posts + 1 WHERE userid = ?`,
      [data.userId]
    )) as unknown as ResultSetHeader;

    if (!res3 || res3.affectedRows === 0)
      throw new Error("User post count update failed");

    // Update topic metadata
    const res4 = (await queryDatabase(
      connection,
      `UPDATE jos_kunena_topics
       SET last_post_id = ?, last_post_time = ?, last_post_userid = ?, last_post_guest_name = ?
       WHERE id = ?`,
      [messageId, timestamp, data.userId, data.name, data.threadId]
    )) as unknown as ResultSetHeader;

    if (!res4 || res4.affectedRows === 0)
      throw new Error("Topic metadata update failed");

    // Update category metadata
    const res5 = (await queryDatabase(
      connection,
      `UPDATE jos_kunena_categories
      SET last_post_id = ?, last_post_time = ?
      WHERE id = ?`,
      [messageId, timestamp, data.categoryId]
    )) as unknown as ResultSetHeader;

    if (!res5 || res5.affectedRows === 0)
      throw new Error("Category metadata update failed");

    // Update community activity

    // Build activity title HTML
    const activityTitle = `{single}{actor}{/single}{multiple}{actors}{/multiple} replied to the topic '<a href="/forum/${data.categoryId}/${data.threadId}">${data.subject}</a>' in the forum.`;

    // Optional: extract plain-text from message (strip BBCode for preview)
    const strippedMessage = data.message.replace(/\[.*?\]/g, "").trim();
    const previewText = strippedMessage.substring(0, 300); // Limit for readability

    // Optional image + "Read More" link
    const readMoreUrl = `/forum/${data.categoryId}/${data.threadId}/${messageId}`;
    const imageTag = `<a href="${data.imageURL}" rel="nofollow" target="_blank">${data.imageURL}</a><br><br>`;

    // Build content block
    const activityContent = `
      <div class="bbcode_center" style="text-align:center;">
        <b>${data.subject}</b>
      </div>
      <br>
      ${imageTag}
      ${previewText}
      <br>
      <br>
      <a rel="nofollow" href="${readMoreUrl}" class="small profile-newsfeed-item-action">Read More...</a>
    `.trim();

    const res6 = (await queryDatabase(
      connection,
      `INSERT INTO jos_community_activities
   (actor, target, title, content, app, verb, cid, created, access, points, archived, comment_id, comment_type, like_id, like_type, updated_at, params, location, latitude, longitude, actors)
   VALUES (?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?)`,
      [
        data.userId,
        0,
        activityTitle,
        activityContent,
        "kunena.thread.reply", // app
        "kunena.thread.reply", // verb
        data.threadId, // cid
        timestamp,
        0, // access
        1, // points — seems to always be 1
        0, // archived
        data.threadId, // comment_id
        "kunena.thread.reply", // comment_type
        0, // like_id (update after insertion to this entry id)
        "kunena.thread.reply", // like_type
        timestamp,
        "", // params
        "", // location
        255, // latitude
        255, // longitude
        "", // actors
      ]
    )) as unknown as ResultSetHeader;

    if (!res6 || res6.affectedRows === 0)
      throw new Error("Community activity insert failed");

    // Update the like_id in the activity entry
    const activityId = res6.insertId;
    const res7 = (await queryDatabase(
      connection,
      `UPDATE jos_community_activities SET like_id = ? WHERE id = ?`,
      [activityId, activityId]
    )) as unknown as ResultSetHeader;

    if (!res7 || res7.affectedRows === 0)
      throw new Error("Community activity like_id update failed");

    // All good — commit
    await connection.commit();

    await setLastProcessedDate(data.created);

    logger.info(
      `✅ Inserted message ID ${messageId} and updated user/topic/category in transaction`
    );
  } catch (err) {
    await connection.rollback();
    logger.error("❌ Transaction failed, rolled back:", err);
  }
}

async function getSubjectAndParent(
  connection: Connection,
  categoryId: string,
  threadId: string
) {
  const res = await queryDatabase(
    connection,
    "SELECT subject, first_post_id FROM jos_kunena_topics WHERE category_id = ? AND id = ? LIMIT 1",
    [categoryId, threadId]
  );

  if (!res || res.length === 0) return;

  return { subject: res[0].subject, parentId: res[0].first_post_id };
}

async function getImage(connection: Connection, listingId: number) {
  const res = await queryDatabase(
    connection,
    "SELECT * FROM jos_jreviews_media WHERE listing_id = ? AND main_media = 1 LIMIT 1",
    [listingId]
  );

  if (!res || res.length === 0) return;

  const imageObj = res[0];

  return `https://gameworld.gr/media/reviews/photos/${imageObj.rel_path}${imageObj.filename}.${imageObj.file_extension}`;
}

const MAX_RECURSION = 100;
async function processPost(connection: Connection, created: string, depth = 0) {
  if (depth % 100 === 0) {
    logger.info(`Recursion depth: ${depth}`);
  }

  if (depth > MAX_RECURSION) {
    logger.info("Max recursion depth reached. Exiting.");
    return;
  }

  const nextPost = await getNextPost(connection, created);
  if (!nextPost) {
    logger.info("No next post found.");
    return;
  } else {
    console.log(nextPost.id, "Created:", nextPost.created, nextPost.title);
  }

  const HTML2BBCode = require("../node_modules/html2bbcode").HTML2BBCode;

  const converter = new HTML2BBCode();

  const $ = cheerio.load(nextPost.fulltext, null, false);

  const elements = $.root().children().toArray();

  const unrolledElements = elements.map((el) => unrollElements(el, $)).flat();

  // Find the latest UPDATE element from the unrolled elements
  const updateIndexReverse = [...unrolledElements]
    .reverse()
    .map((el) => $(el).text())
    .findIndex((text) => UPDATE_REGEX.test(text));

  const updateElements: Element[] = [];
  if (updateIndexReverse === -1) {
    updateElements.push(...unrolledElements);
  } else {
    updateElements.push(
      ...unrolledElements.slice(
        unrolledElements.length - updateIndexReverse - 1
      )
    );
  }

  const updateTitle = $(updateElements[0]).text().match(UPDATE_REGEX)?.[0];

  let strippedTitle = "";

  if (updateTitle) {
    const reversedTitle = updateTitle.split("").reverse().join("");
    for (const char of reversedTitle) {
      if (["-", ":", "[", "—", "–"].includes(char)) {
        break;
      } else if (["]"].includes(char)) {
        continue;
      } else {
        strippedTitle += char;
      }
    }
  }

  // Regex to find the category id and forum thread id in the URL
  // Ex. forum/59/163262
  // Keep only the last match

  const urlRegex = /forum\/(\d+)\/(\d+)/g;
  const urlMatch: any = Array.from(nextPost.fulltext.matchAll(urlRegex)).pop();

  let categoryId = "";
  let threadId = "";

  if (urlMatch) {
    categoryId = urlMatch[1];
    threadId = urlMatch[2];
  } else {
    logger.info("Skipping post, no URL found.");
    await processPost(connection, formatDate(nextPost.created), depth + 1);
    return;
  }

  const subjectAndParent = await getSubjectAndParent(
    connection,
    categoryId,
    threadId
  );

  if (!subjectAndParent) {
    logger.info("Skipping post, no subject and parent found.");
    await processPost(connection, formatDate(nextPost.created), depth + 1);
    return;
  }

  let foundForumTopic = false;
  const finalTitle =
    strippedTitle.split("").reverse().join("") || nextPost.title.trim();
  const finalUpdates = updateElements
    .map((el) => {
      return $.html(el)
        ?.replace(/\[UPDATE.*\][ ]*/g, "")
        .trim();
    })
    .filter((el, index) => {
      if (foundForumTopic) {
        return false;
      }

      if (
        index === updateElements.length - 1 ||
        index === updateElements.length - 2
      ) {
        foundForumTopic = true;
        return !$(el).text().includes("forum topic");
      }

      return true;
    });

  const imageURL = await getImage(connection, nextPost.id);
  if (!imageURL) {
    logger.info("No image found, skipping post.");
    await processPost(connection, formatDate(nextPost.created), depth + 1);
    return;
  }

  const bbcode = finalUpdates
    .map((el) => converter.feed(el).toString())
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");

  const finalPost = `[center][b]${finalTitle}[/b][/center]\n\n[img]${imageURL}[/img]\n\n${bbcode}`;

  const hasPosted = await hasBeenPosted(connection, finalPost);
  if (hasPosted) {
    logger.info("Already posted, skipping.");
    await processPost(connection, formatDate(nextPost.created), depth + 1);
    return;
  }

  await insertMessage(connection, {
    parentId: subjectAndParent?.parentId,
    threadId: Number(threadId),
    categoryId: Number(categoryId),
    subject: subjectAndParent?.subject,
    message: finalPost,
    userId: Number(process.env.USER_ID!),
    name: process.env.USER_NAME!,
    created: nextPost.created,
    imageURL: imageURL,
  });

  const postUrl = `https://gameworld.gr/forum/${categoryId}/${threadId}`;
  logger.info(`Posted at: ${postUrl}`);
}

async function hasBeenPosted(connection: Connection, message: string) {
  const res = await queryDatabase(
    connection,
    `SELECT jos_kunena_messages_text.* FROM jos_kunena_messages_text INNER JOIN jos_kunena_messages ON jos_kunena_messages.id = jos_kunena_messages_text.mesid WHERE jos_kunena_messages.userid = ? AND jos_kunena_messages_text.message = ? LIMIT 1`,
    [Number(process.env.USER_ID!), message]
  );

  if (!res || res.length === 0) return false;

  return true;
}

function unrollElements(element: Element, $: cheerio.CheerioAPI): Element[] {
  const text = $(element).text();
  const hasUpdate = UPDATE_REGEX.test(text);

  if (element.tagName !== "div" || !hasUpdate) {
    return [element];
  }

  const children = $(element).children().toArray();

  const unrolledElements: Element[] = [];

  for (const child of children) {
    unrolledElements.push(...unrollElements(child, $));
  }

  return unrolledElements;
}
