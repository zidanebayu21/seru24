import { describe, expect, it, vi } from 'vitest'
import { createAccountCore, type AccountState, type KeyStore, type Me } from '../../shared/account-core'
import { derivePasswordSecrets, newAuthSalt } from '../../shared/crypto'

describe('account-core', () => {
  const dummyMe: Me = {
    id: 'user-1',
    username: 'user1',
    display_name: 'User One',
    has_keys: false,
    key_version: null,
  }

  const makeKeyStore = (): KeyStore & { store: Map<string, any> } => {
    const store = new Map<string, any>()
    return {
      store,
      load: vi.fn(async (id: string) => store.get(id) ?? null),
      save: vi.fn(async (id: string, ring: any) => { store.set(id, ring) }),
      remove: vi.fn(async (id: string) => { store.delete(id) }),
    }
  }

  it('membuat kunci awal untuk akun baru dengan pending key material', async () => {
    const keyStore = makeKeyStore()
    const state: AccountState = { me: null, status: 'unknown' }
    let remoteBackup: any = null

    const rpc = vi.fn(async (fn: string, args: any) => {
      if (fn === 'seru24_register_device') return 'ok'
      if (fn === 'seru24_me') return { ...dummyMe }
      if (fn === 'seru24_set_initial_keys') {
        remoteBackup = args
        return 'ok'
      }
      return null
    })

    const account = createAccountCore({ rpc, keyStore, platform: 'web', deviceName: () => 'Test Browser' }, state)

    const salt = newAuthSalt()
    const { wrapKey } = await derivePasswordSecrets('pass1234', salt)
    account.setPendingKeyMaterial(wrapKey, salt)

    const status = await account.bootstrapAccount(true)
    expect(status).toBe('ready')
    expect(state.status).toBe('ready')
    expect(state.me?.has_keys).toBe(true)
    expect(state.me?.key_version).toBe(1)
    expect(account.getKeyring()).toBeTruthy()
    expect(keyStore.save).toHaveBeenCalled()
    expect(remoteBackup).toBeTruthy()

    await account.resetAccount()
    expect(account.getKeyring()).toBeNull()
    expect(state.status).toBe('unknown')
    expect(keyStore.remove).toHaveBeenCalledWith('user-1')
  })

  it('memulihkan kunci dari backup server untuk perangkat baru', async () => {
    const keyStore = makeKeyStore()
    const state: AccountState = { me: null, status: 'unknown' }

    const salt = newAuthSalt()
    const { wrapKey } = await derivePasswordSecrets('pass1234', salt)

    let createdBackup: any = null
    const rpcCreate = vi.fn(async (fn: string, args: any) => {
      if (fn === 'seru24_register_device') return 'ok'
      if (fn === 'seru24_me') return { ...dummyMe }
      if (fn === 'seru24_set_initial_keys') {
        createdBackup = {
          encrypted_keys: args.p_encrypted_keys,
          nonce: args.p_nonce,
          kdf: args.p_kdf,
          kdf_params: args.p_kdf_params,
        }
        return 'ok'
      }
      return null
    })

    const account1 = createAccountCore({ rpc: rpcCreate, keyStore, platform: 'web', deviceName: () => 'Device 1' }, state)
    account1.setPendingKeyMaterial(new Uint8Array(wrapKey), salt)
    await account1.bootstrapAccount(true)

    const rpcRestore = vi.fn(async (fn: string) => {
      if (fn === 'seru24_register_device') return 'ok'
      if (fn === 'seru24_me') return { ...dummyMe, has_keys: true, key_version: 1 }
      if (fn === 'seru24_get_key_backup') return createdBackup
      if (fn === 'seru24_trust_device') return 'ok'
      return null
    })

    const emptyStore = makeKeyStore()
    const state2: AccountState = { me: null, status: 'unknown' }
    const account2 = createAccountCore({ rpc: rpcRestore, keyStore: emptyStore, platform: 'web', deviceName: () => 'Device 2' }, state2)
    account2.setPendingKeyMaterial(new Uint8Array(wrapKey), salt)

    const status2 = await account2.bootstrapAccount(true)
    expect(status2).toBe('ready')
    expect(account2.getKeyring()).toBeTruthy()
    expect(rpcRestore).toHaveBeenCalledWith('seru24_trust_device')
  })

  it('memuat kunci offline dari keystore lokal', async () => {
    const keyStore = makeKeyStore()
    const state: AccountState = { me: null, status: 'unknown' }
    const account = createAccountCore({ rpc: vi.fn(), keyStore, platform: 'web', deviceName: () => 'Test' }, state)

    const meWithKeys: Me = { ...dummyMe, has_keys: true, key_version: 1 }
    keyStore.store.set('user-1', { '1': new Uint8Array(32) })

    const ok = await account.loadOfflineKeys(meWithKeys)
    expect(ok).toBe(true)
    expect(account.getKeyring()).toBeTruthy()
    expect(state.me).toEqual(meWithKeys)

    const notOk = await account.loadOfflineKeys({ ...meWithKeys, key_version: 2 })
    expect(notOk).toBe(false)
  })
})
