import { describe, expect, it } from 'vitest';
import { parseCurrentEvents, rankNews } from './webtools';

const page = `{{Current events|year=2026|month=10|day=5}}
'''Armed conflicts and attacks'''
*[[Yemeni civil war (2014–present)|Yemeni civil war]]
**[[2026 Yemen offensives]]
***The [[Houthis]] retake a district near the coast. [https://example.com/a (Reuters)] [https://example.com/b (''Al Jazeera'')]
'''Business and economy'''
*[[2026 Brazilian general election]]
**[[Brazil]]'s stock index rises after the first round of the election. [https://example.com/c (AFP)]
*Mali signs a mining deal with a foreign company. [https://example.com/d (AP)]
`;

describe('Wikipedia Current events', () => {
  const items = parseCurrentEvents(page, '2026-10-05');
  it('keeps the deepest bullets with their story, category and outlets', () => {
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ category: 'Armed conflicts and attacks', story: ['Yemeni civil war', '2026 Yemen offensives'], sources: ['Reuters', 'Al Jazeera'] });
    expect(items[0].text).toBe('The Houthis retake a district near the coast.');
  });
  it('ranks by whole words of the topic', () => {
    expect(rankNews(items, 'Brazil election').map((i) => i.text)).toEqual(["Brazil's stock index rises after the first round of the election."]);
    // "AI" must not match "Mali".
    expect(rankNews(items, 'AI')).toEqual([]);
  });
});
