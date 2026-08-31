// Tells the app which AI capabilities the deployment provides platform keys for,
// so signed-in users don't need to bring their own.
export default function handler(req, res) {
  res.status(200).json({
    chat: Boolean(process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY),
    stt: Boolean(process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY)
  })
}
