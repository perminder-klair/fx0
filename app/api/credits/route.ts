import { resolveGrantedTeam } from '../../../lib/auth'
import { withUserRoute } from '../../../lib/route-auth'
import { selfHosted } from '../../../lib/self-hosted'

export const maxDuration = 30

// Gateway rejections are about the team, not the fx0 session. They
// map to 4xx/5xx that never read as 401/403, which would sign the UI out.
function upstreamStatus(status: number): number {
  return status === 401 || status === 403 ? 422 : status === 402 ? 402 : status >= 500 ? 502 : 400
}

export const GET = withUserRoute(async (_request, { session }) => {
  // A self-hosted provider has no AI Gateway balance, and its session no Gateway token.
  if (selfHosted()) return Response.json({ balance: null, totalUsed: 0, flexible: false })
  const { teamId } = await resolveGrantedTeam(session)
  const response = await fetch(`https://ai-gateway.vercel.sh/v1/credits?teamId=${encodeURIComponent(teamId)}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return Response.json({ error: 'Balance unavailable' }, { status: upstreamStatus(response.status) })
  const { balance, total_used: totalUsed } = await response.json() as { balance?: string; total_used?: string }
  const amount = Number(balance)
  // Flex-commitment teams bill against a commitment, so their balance is
  // negative by design and buying credits does not apply.
  return Response.json({ balance: Number.isFinite(amount) ? amount : null, totalUsed: Number(totalUsed) || 0, flexible: amount < 0 })
})
