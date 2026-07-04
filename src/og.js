// Dynamic OG images for result pages: /og/<key>.png renders the verdict card
// ("@handle is 27.5% clanker") in the site's design via Satori + resvg
// (workers-og) — no browser involved. Fonts are bundled as Data modules
// (woff; satori can't read woff2). The layout mirrors the approved mock:
// graph-paper background, corner tag, big glitch-shadow score, verdict quip,
// domain bottom-right.
import { ImageResponse } from 'workers-og';
import orbitron900 from '@fontsource/orbitron/files/orbitron-latin-900-normal.woff';
import orbitron700 from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff';
import azeret400 from '@fontsource/azeret-mono/files/azeret-mono-latin-400-normal.woff';

// Verdict quips, thresholds descending (server-side copies of the client's).
const ACCOUNT_VERDICTS = [
  [85, 'heavy clanker energy. tweets like a press release wrote itself.'],
  [60, 'a lot of clanker in the timeline. the algorithm approves.'],
  [35, 'some synthetic residue, but a pulse is detectable.'],
  [15, 'mostly human. trace amounts of clanker.'],
  [0, 'certified organic. posts no model saw coming.'],
];
const SELF_VERDICTS = [
  [85, 'beep boop. welcome home, unit.'],
  [60, 'heavy clanker energy. do you dream of electric sheep?'],
  [35, 'suspiciously synthetic. a language model would like to know your location.'],
  [15, 'mostly human. trace amounts of clanker.'],
  [0, 'certified organic. unpredictable in ways no lab can reproduce.'],
];
const verdictFor = (list, overall) => list.find(([min]) => overall >= min)[1];

// The glitch shadow is a layered duplicate (cyan copy offset behind the
// magenta score) — more portable than text-shadow across satori versions.
function cardHtml(row) {
  const acct = row.subject_type === 'account';
  const reddit = row.subject_platform === 'reddit';
  const who = acct ? `${reddit ? 'u/' : '@'}${row.subject_handle} is` : 'certified';
  const tail = 'clanker';
  const quip = verdictFor(acct ? ACCOUNT_VERDICTS : SELF_VERDICTS, row.overall).replace(
    'tweets',
    reddit ? 'comments' : 'tweets'
  );
  const context = acct
    ? `graded from public ${reddit ? 'comments on reddit' : 'posts on X'}`
    : 'a surprisal Turing test, reversed';
  const score = `${row.overall}%`;
  return `
  <div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;
    background-color:#f2efe6;color:#14110f;padding:56px 64px 44px;font-family:'Azeret Mono';
    background-image:linear-gradient(#d8d3c4 2%, transparent 2%),linear-gradient(90deg, #d8d3c4 2%, transparent 2%);
    background-size:32px 32px;">
    <div style="display:flex;">
      <div style="display:flex;border:2px solid #14110f;padding:5px 16px;font-size:18px;letter-spacing:3px;">// THE CLANKER TEST</div>
    </div>
    <div style="display:flex;flex-direction:column;">
      <div style="display:flex;color:#6f6a5f;font-size:22px;">${context}</div>
      <div style="display:flex;flex-direction:column;font-family:'Orbitron';font-weight:700;font-size:84px;margin-top:18px;line-height:1.15;">
        <div style="display:flex;">${who}</div>
        <div style="display:flex;align-items:flex-end;">
          <div style="display:flex;position:relative;">
            <div style="display:flex;position:absolute;left:5px;top:0;color:#00a6c4;font-weight:900;font-size:128px;">${score}</div>
            <div style="display:flex;color:#ff1e79;font-weight:900;font-size:128px;">${score}</div>
          </div>
          <div style="display:flex;margin-left:28px;margin-bottom:10px;">${tail}</div>
        </div>
      </div>
      <div style="display:flex;color:#6f6a5f;font-size:30px;margin-top:16px;">${quip}</div>
    </div>
    <div style="display:flex;justify-content:flex-end;font-family:'Orbitron';font-weight:900;font-size:30px;letter-spacing:1px;">
      HOWCLANKERAREYOU.COM
    </div>
  </div>`;
}

export async function ogImage(row) {
  return new ImageResponse(cardHtml(row), {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Orbitron', data: orbitron900, weight: 900, style: 'normal' },
      { name: 'Orbitron', data: orbitron700, weight: 700, style: 'normal' },
      { name: 'Azeret Mono', data: azeret400, weight: 400, style: 'normal' },
    ],
  });
}
