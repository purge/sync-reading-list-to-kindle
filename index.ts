#! /usr/bin/env deno

import { parseBuffer } from "https://deno.land/x/bplist_parser@0.4.0/mod.ts";
import { delay } from "https://deno.land/x/delay@v0.2.0/mod.ts";
import { DB } from "https://deno.land/x/sqlite@v3.5.0/mod.ts";
import { bool, cleanEnv, str } from "https://deno.land/x/envalid@0.1.2/mod.ts";

const env = cleanEnv(Deno.env.toObject(), {
  HOME: str(),
  RESET_DB: bool({ default: false }),
  SENDTOREADER_USERNAME: str(),
  SENDTOREADER_PASSWORD: str(),
});

const file = await Deno.readFile(`${env.HOME}/Library/Safari/Bookmarks.plist`);

type BookMarksPlistShape = {
  Children: {
    Title: string;
    WebBookmarkType: string;
    Children: {
      URIDictionary: { title: string };
      Sync: { ServerID: string };
      ReadingListNonSync: {
        FetchResult: number;
        neverFetchMetadata: boolean;
        DateLastFetched: string;
        PreviewText: string;
      };
      WebBookmarkType: string;
      WebBookmarkUUID: string;
      URLString: string;
      ReadingList: {
        DateAdded: string;
        PreviewText: string;
      };
    }[];
  }[];
};

const bookmarks = parseBuffer(file) as BookMarksPlistShape;
const readingList = bookmarks.Children.find((i) =>
  i.Title === "com.apple.ReadingList"
);

if (!readingList) {
  console.log(`no reading list found`);
  Deno.exit();
}

type ArticleRow = {
  url: string;
  title: string;
  description: string;
  date_added: string;
  sent: number;
};

const items: Omit<ArticleRow, "sent">[] = readingList.Children.map((item) => ({
  title: item.URIDictionary.title,
  description: item.ReadingList.PreviewText,
  url: item.URLString,
  date_added: new Date(item.ReadingList.DateAdded).toISOString(),
}));

// Open a database
const db = new DB("kindle.db");

if (env.RESET_DB) {
  db.execute(`drop table articles`);
}

db.execute(`
  create table if not exists articles (
    url text primary key,
    title text not null,
    description text,
    date_added text not null,
		sent integer default false
  )
`);

const toSend: ArticleRow[] = [];

for (const item of items) {
  const all = await db.queryEntries<
    ArticleRow
  >(
    `select * from articles where url = ? limit 1`,
    [item.url],
  );
  const record = all[0];

  if (!record) {
    const n = await db.queryEntries<ArticleRow>(
      `insert into articles (url, title, description, date_added) values (?, ?, ?, ?) returning *`,
      [item.url, item.title, item.description, item.date_added],
    );
    const record = n[0];
    toSend.push(record);
  } else {
    if (!record.sent) {
      toSend.push(record);
    }
  }
}

const auth = {
  username: env.SENDTOREADER_USERNAME,
  password: env.SENDTOREADER_PASSWORD,
};

for (const item of toSend) {
  console.log(`Sending ${item.url}...`);
  const result = await fetch(
    "https://sendtoreader.com/api/send/?" +
      new URLSearchParams({
        ...auth,
        url: item.url,
      }),
  );
  if (result.ok) {
    console.log(`Done`);
    await db.query(`update articles set sent = true where url = ?`, [item.url]);
  } else {
    console.log(result.status);
    console.log(result.statusText);
  }
  await delay(2000);
}
