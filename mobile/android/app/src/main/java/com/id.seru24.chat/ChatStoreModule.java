package id.seru24.chat;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Penyimpanan cache percakapan & pesan terenkripsi lokal (SQLite) di Android,
 * paralel dengan IndexedDB seru24_chat_cache di aplikasi web.
 */
public class ChatStoreModule extends ReactContextBaseJavaModule {
    private static final String DB_NAME = "seru24_chat_cache.db";
    private static final int DB_VERSION = 1;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private ChatDbHelper dbHelper;

    ChatStoreModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "Seru24ChatStore";
    }

    private synchronized SQLiteDatabase getDb() {
        if (dbHelper == null) {
            dbHelper = new ChatDbHelper(getReactApplicationContext());
        }
        return dbHelper.getWritableDatabase();
    }

    private synchronized void closeDb() {
        if (dbHelper != null) {
            dbHelper.close();
            dbHelper = null;
        }
    }

    @ReactMethod
    public void saveConversations(String userId, ReadableArray rows, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                long now = System.currentTimeMillis();
                db.beginTransaction();
                try {
                    db.delete("conversations", "user_id = ?", new String[]{userId});
                    for (int i = 0; i < rows.size(); i++) {
                        ReadableMap row = rows.getMap(i);
                        if (row == null) continue;
                        ContentValues cv = new ContentValues();
                        cv.put("cache_key", row.getString("cacheKey"));
                        cv.put("user_id", userId);
                        cv.put("conversation_id", row.getString("conversationId"));
                        cv.put("sealed", row.getString("sealed"));
                        cv.put("updated_at", now);
                        db.insertWithOnConflict("conversations", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                    }
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
                promise.resolve(null);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void loadConversations(String userId, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                WritableArray list = Arguments.createArray();
                try (Cursor cursor = db.rawQuery(
                        "SELECT sealed FROM conversations WHERE user_id = ?",
                        new String[]{userId})) {
                    while (cursor.moveToNext()) {
                        list.pushString(cursor.getString(0));
                    }
                }
                promise.resolve(list);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void saveMessages(String userId, String conversationId, ReadableArray rows, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                long now = System.currentTimeMillis();
                db.beginTransaction();
                try {
                    for (int i = 0; i < rows.size(); i++) {
                        ReadableMap row = rows.getMap(i);
                        if (row == null) continue;
                        ContentValues cv = new ContentValues();
                        cv.put("cache_key", row.getString("cacheKey"));
                        cv.put("user_id", userId);
                        cv.put("conversation_id", conversationId);
                        cv.put("seq", (long) row.getDouble("seq"));
                        cv.put("sealed", row.getString("sealed"));
                        cv.put("updated_at", now);
                        db.insertWithOnConflict("messages", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                    }
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
                promise.resolve(null);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void loadConversationState(String userId, String conversationId, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                WritableArray messages = Arguments.createArray();
                WritableArray deletedIds = Arguments.createArray();
                long clearedUpToSeq = 0;

                try (Cursor msgCursor = db.rawQuery(
                        "SELECT sealed FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY seq ASC",
                        new String[]{userId, conversationId})) {
                    while (msgCursor.moveToNext()) {
                        messages.pushString(msgCursor.getString(0));
                    }
                }

                try (Cursor delCursor = db.rawQuery(
                        "SELECT client_msg_id FROM deleted_msgs WHERE user_id = ? AND conversation_id = ?",
                        new String[]{userId, conversationId})) {
                    while (delCursor.moveToNext()) {
                        deletedIds.pushString(delCursor.getString(0));
                    }
                }

                String clearKey = userId + ":" + conversationId;
                try (Cursor clrCursor = db.rawQuery(
                        "SELECT cleared_up_to_seq FROM cleared_conv WHERE cache_key = ? LIMIT 1",
                        new String[]{clearKey})) {
                    if (clrCursor.moveToFirst()) {
                        clearedUpToSeq = clrCursor.getLong(0);
                    }
                }

                WritableMap result = Arguments.createMap();
                result.putArray("messages", messages);
                result.putArray("deletedIds", deletedIds);
                result.putDouble("clearedUpToSeq", (double) clearedUpToSeq);
                promise.resolve(result);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void clearConversation(String userId, String conversationId, double upToSeq, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                String clearKey = userId + ":" + conversationId;
                long existingSeq = 0;
                try (Cursor cursor = db.rawQuery(
                        "SELECT cleared_up_to_seq FROM cleared_conv WHERE cache_key = ? LIMIT 1",
                        new String[]{clearKey})) {
                    if (cursor.moveToFirst()) {
                        existingSeq = cursor.getLong(0);
                    }
                }
                long nextSeq = Math.max(existingSeq, (long) upToSeq);
                long now = System.currentTimeMillis();

                db.beginTransaction();
                try {
                    String[] args = new String[]{userId, conversationId};
                    db.delete("messages", "user_id = ? AND conversation_id = ?", args);
                    db.delete("deleted_msgs", "user_id = ? AND conversation_id = ?", args);
                    ContentValues cv = new ContentValues();
                    cv.put("cache_key", clearKey);
                    cv.put("user_id", userId);
                    cv.put("conversation_id", conversationId);
                    cv.put("cleared_up_to_seq", nextSeq);
                    cv.put("cleared_at", now);
                    db.insertWithOnConflict("cleared_conv", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
                promise.resolve(null);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void clearAllChats(String userId, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                db.beginTransaction();
                try {
                    String[] tables = new String[]{"conversations", "messages", "deleted_msgs", "cleared_conv"};
                    if (userId != null && !userId.isEmpty()) {
                        String[] args = new String[]{userId};
                        for (String table : tables) {
                            db.delete(table, "user_id = ?", args);
                        }
                    } else {
                        for (String table : tables) {
                            db.delete(table, null, null);
                        }
                    }
                    db.setTransactionSuccessful();
                } finally {
                    db.endTransaction();
                }
                promise.resolve(null);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void resetDatabase(Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                closeDb();
                getReactApplicationContext().deleteDatabase(DB_NAME);
                promise.resolve(null);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    @ReactMethod
    public void getStats(String userId, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                SQLiteDatabase db = getDb();
                long convCount = 0;
                long msgCount = 0;

                try (Cursor c = db.rawQuery(
                        "SELECT COUNT(*) FROM conversations WHERE user_id = ?",
                        new String[]{userId})) {
                    if (c.moveToFirst()) convCount = c.getLong(0);
                }
                try (Cursor m = db.rawQuery(
                        "SELECT COUNT(*) FROM messages WHERE user_id = ?",
                        new String[]{userId})) {
                    if (m.moveToFirst()) msgCount = m.getLong(0);
                }

                File dbFile = getReactApplicationContext().getDatabasePath(DB_NAME);
                long sizeBytes = dbFile != null && dbFile.exists() ? dbFile.length() : 0L;

                WritableMap result = Arguments.createMap();
                result.putDouble("conversations", (double) convCount);
                result.putDouble("messages", (double) msgCount);
                result.putDouble("sizeBytes", (double) sizeBytes);
                promise.resolve(result);
            } catch (Exception e) {
                promise.reject("chat_store_error", e);
            }
        });
    }

    private static class ChatDbHelper extends SQLiteOpenHelper {
        ChatDbHelper(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS conversations (" +
                    "cache_key TEXT PRIMARY KEY, " +
                    "user_id TEXT NOT NULL, " +
                    "conversation_id TEXT NOT NULL, " +
                    "sealed TEXT NOT NULL, " +
                    "updated_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations (user_id)");

            db.execSQL("CREATE TABLE IF NOT EXISTS messages (" +
                    "cache_key TEXT PRIMARY KEY, " +
                    "user_id TEXT NOT NULL, " +
                    "conversation_id TEXT NOT NULL, " +
                    "seq INTEGER NOT NULL, " +
                    "sealed TEXT NOT NULL, " +
                    "updated_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_user ON messages (user_id)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (user_id, conversation_id)");

            db.execSQL("CREATE TABLE IF NOT EXISTS deleted_msgs (" +
                    "cache_key TEXT PRIMARY KEY, " +
                    "user_id TEXT NOT NULL, " +
                    "conversation_id TEXT NOT NULL, " +
                    "client_msg_id TEXT NOT NULL, " +
                    "seq INTEGER NOT NULL, " +
                    "deleted_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_del_user ON deleted_msgs (user_id)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_del_conv ON deleted_msgs (user_id, conversation_id)");

            db.execSQL("CREATE TABLE IF NOT EXISTS cleared_conv (" +
                    "cache_key TEXT PRIMARY KEY, " +
                    "user_id TEXT NOT NULL, " +
                    "conversation_id TEXT NOT NULL, " +
                    "cleared_up_to_seq INTEGER NOT NULL, " +
                    "cleared_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_clr_user ON cleared_conv (user_id)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            // Skema v1 awal; migrasi versi berikutnya akan ditangani per langkah di sini.
        }
    }
}
