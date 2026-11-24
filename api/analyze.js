export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(501).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." });

  const { trackName, artistName, albumName, genreHint, lyrics, bpm, keyName } = req.body || {};
  if (!trackName || !artistName) return res.status(400).json({ error: "trackName과 artistName이 필요합니다." });

  const prompt = `당신은 프로듀서와 DJ를 위한 음악 분석가입니다. 아래 곡의 사운드 특징을 분석하세요.

- 곡명: ${trackName}
- 아티스트: ${artistName}
- 앨범: ${albumName || "Single"}
- 장르 힌트: ${genreHint || "Unknown"}
- 오디오에서 측정한 BPM: ${bpm || "측정 안 됨"}
- 오디오에서 측정한 키: ${keyName || "측정 안 됨"}
- 가사:
${String(lyrics || "가사 없음").slice(0, 2500)}

규칙:
1. categories는 정확히 4개: "장르 & 세부 장르", "주요 악기", "보컬 스타일", "분위기". 각 2~4개 항목.
2. conf는 해당 태그에 대한 당신의 추정 확신도(50~99 정수)입니다. 모르면 낮게 주세요.
3. lyricsSummary와 moodKeywords, note는 한국어로 작성하세요.
4. stylePrompt는 Suno/Udio에 붙여넣을 영어 키워드 한 줄이며, 측정된 BPM과 키가 있으면 포함하세요.`;

  const item = {
    type: "OBJECT",
    properties: { label: { type: "STRING" }, conf: { type: "INTEGER" }, note: { type: "STRING" } },
    required: ["label", "conf", "note"]
  };
  const responseSchema = {
    type: "OBJECT",
    properties: {
      categories: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { title: { type: "STRING" }, items: { type: "ARRAY", items: item } },
          required: ["title", "items"]
        }
      },
      moodKeywords: { type: "ARRAY", items: { type: "STRING" } },
      lyricsSummary: { type: "STRING" },
      stylePrompt: { type: "STRING" }
    },
    required: ["categories", "moodKeywords", "lyricsSummary", "stylePrompt"]
  };

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema }
        })
      }
    );
    if (!r.ok) return res.status(r.status).json({ error: `Gemini API 오류 (${r.status})` });

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: "Gemini 응답이 비어 있습니다." });
    return res.status(200).json(JSON.parse(text));
  } catch (err) {
    return res.status(500).json({ error: err.message || "분석 실패" });
  }
}
