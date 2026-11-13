import type { AuthError } from '@supabase/supabase-js'
import type { H3Event } from 'h3'

// Kode error Supabase Auth -> pesan untuk pengguna. Detail asli tetap hanya di system_logs.
const SIGNUP_ERRORS: Record<string, { status: number; message: string }> = {
  email_address_invalid: { status: 400, message: 'Alamat email ditolak. Gunakan email aktif milik Anda.' },
  email_address_not_authorized: { status: 400, message: 'Alamat email ditolak. Gunakan email aktif milik Anda.' },
  over_email_send_rate_limit: { status: 429, message: 'Terlalu banyak pendaftaran. Coba lagi beberapa saat lagi.' },
  over_request_rate_limit: { status: 429, message: 'Terlalu banyak pendaftaran. Coba lagi beberapa saat lagi.' },
  weak_password: { status: 400, message: 'Password terlalu lemah.' },
}
const SIGNUP_FALLBACK = { status: 400, message: 'Pendaftaran gagal. Periksa data atau coba username lain.' }

const signupError = (error: AuthError) => {
  const mapped = SIGNUP_ERRORS[error.code ?? ''] ?? SIGNUP_FALLBACK
  return createError({ statusCode: mapped.status, statusMessage: mapped.message, cause: error })
}

interface SignupInput {
  email: string
  password: string
  metadata: { username: string; display_name: string }
}

/** Alur normal: Supabase mengirim email verifikasi (OWASP ASVS V2.1). */
const signUpWithEmailConfirmation = async (event: H3Event, input: SignupInput) => {
  const { data, error } = await authClient(event).auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: input.metadata, emailRedirectTo: `${getRequestURL(event).origin}/login?verified=1` },
  })
  if (error) throw signupError(error)
  return { userId: data.user?.id ?? null, session: data.session }
}

/**
 * Masa uji (NUXT_AUTH_SKIP_EMAIL_CONFIRM=true): akun dibuat lewat Admin API dengan email langsung
 * terverifikasi, tanpa mengirim email, lalu langsung login.
 */
const signUpWithoutEmailConfirmation = async (event: H3Event, input: SignupInput) => {
  const admin = serviceClient(event)
  if (!admin) throw new Error('Konfigurasi belum lengkap: NUXT_SUPABASE_SERVICE_ROLE_KEY kosong')
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: input.metadata,
  })
  if (error) throw signupError(error)

  const login = await authClient(event).auth.signInWithPassword({ email: input.email, password: input.password })
  if (login.error || !login.data.session) {
    throw new Error(`Login otomatis setelah daftar gagal: ${login.error?.message ?? 'tanpa sesi'}`)
  }
  return { userId: data.user.id, session: login.data.session }
}

export default defineLoggedHandler(async (event) => {
  assertSameOrigin(event)
  const body = await readBody(event)
  const input: SignupInput = {
    email: parseEmail(body?.email),
    password: parsePassword(event, body?.password),
    metadata: { username: parseUsername(body?.username), display_name: parseDisplayName(body?.display_name) },
  }

  const skipConfirm = String(useRuntimeConfig(event).authSkipEmailConfirm) === 'true'
  const { userId, session } = skipConfirm
    ? await signUpWithoutEmailConfirmation(event, input)
    : await signUpWithEmailConfirmation(event, input)

  if (userId) {
    await logAuthSuccess(event, 'register_success', userId, `Pendaftaran berhasil (@${input.metadata.username})`)
  }
  if (session) {
    return { status: 'active', ...issueSession(event, session) }
  }
  return { status: 'verify_email' }
}, { rejectedEvent: 'register_rejected', channel: 'auth' })
