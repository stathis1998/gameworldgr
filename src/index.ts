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
  if (!connection) return;

  await processPost(connection);

  await disconnectFromDatabase(connection);
}

main();

async function getLastPostedTitle(
  connection: Connection
): Promise<string | undefined> {
  const res = await queryDatabase(
    connection,
    "SELECT jos_kunena_messages_text.message FROM jos_kunena_messages INNER JOIN jos_kunena_messages_text ON jos_kunena_messages.id = jos_kunena_messages_text.mesid WHERE userid = ? AND jos_kunena_messages_text.message LIKE '%[center][b]%' ORDER BY time DESC LIMIT 10",
    [Number(process.env.USER_ID)]
  );

  if (!res || res.length === 0) return;

  for (const row of res) {
    const extractedCommentTitle = row.message
      .match(/\[b\](.*)\[\/b\]/)?.[1]
      .trim();

    if (extractedCommentTitle) {
      const res2 = await queryDatabase(
        connection,
        "SELECT title FROM jos_content WHERE `title` = ? OR `fulltext` LIKE ? ORDER BY created DESC LIMIT 1",
        [`${extractedCommentTitle}`, `%${extractedCommentTitle}%`]
      );

      if (!res2 || res2.length === 0) continue;

      return res2[0].title;
    }
  }
}

async function getNextPost(connection: Connection, title: string) {
  const res = await queryDatabase(
    connection,
    `SELECT * FROM jos_content
   WHERE created > (
     SELECT created FROM jos_content WHERE title = ? ORDER BY created DESC LIMIT 1
   )
   AND created >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
   AND \`fulltext\` LIKE ?
   ORDER BY created ASC
   LIMIT 1`,
    [title, "%forum topic%"]
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

    // All good — commit
    await connection.commit();

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

const MAX_RECURSION = 10;
async function processPost(connection: Connection, title?: string, depth = 0) {
  if (depth > MAX_RECURSION) {
    logger.info("Max recursion depth reached. Exiting.");
    return;
  }

  let lastPostedTitle = title;
  if (!title) {
    lastPostedTitle = await getLastPostedTitle(connection);
    if (!lastPostedTitle) {
      logger.info("No last posted was title found.");
      return;
    }
  }

  const nextPost = await getNextPost(connection, lastPostedTitle!);
  if (!nextPost) {
    logger.info("No next post found.");
    return;
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

  const urlRegex = /forum\/(\d+)\/(\d+)/;
  const urlMatch = nextPost.fulltext.match(urlRegex);

  let categoryId = "";
  let threadId = "";

  if (urlMatch) {
    categoryId = urlMatch[1];
    threadId = urlMatch[2];
  } else {
    logger.info("Skipping post, no URL found.");
    await processPost(connection, nextPost.title, depth + 1);
    return;
  }

  const subjectAndParent = await getSubjectAndParent(
    connection,
    categoryId,
    threadId
  );

  if (!subjectAndParent) {
    logger.info("No subject and parent found.");
    return;
  }

  let foundForumTopic = false;
  const finalTitle =
    strippedTitle.split("").reverse().join("") || nextPost.title;
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

  const bbcode = finalUpdates
    .map((el) => converter.feed(el).toString())
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n\n");

  const finalPost = `[center][b]${finalTitle}[/b][/center]\n\n[img]${imageURL}[/img]\n\n${bbcode}`;

  await insertMessage(connection, {
    parentId: subjectAndParent?.parentId,
    threadId: Number(threadId),
    categoryId: Number(categoryId),
    subject: subjectAndParent?.subject,
    message: finalPost,
    userId: Number(process.env.USER_ID!),
    name: process.env.USER_NAME!,
  });

  const postUrl = `https://gameworld.gr/forum/${categoryId}/${threadId}`;
  logger.info(`Posted at: ${postUrl}`);
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
