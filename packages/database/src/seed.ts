import 'dotenv/config';

import { $sources } from './schema';
import { getDb } from './database';

async function main() {
  await getDb(process.env.DATABASE_URL!)
    .insert($sources)
    .values({
      id: 1,
      name: 'Hacker news',
      url: 'https://news.ycombinator.com/rss',
      scrape_frequency: 1,
      category: 'news',
      paywall: false,
      lastChecked: new Date(),
    })
    .onConflictDoNothing();
}

main()
  .then(() => {
    console.log('✅ Seeded database');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error seeding database', err);
    process.exit(1);
  });
