package ai.local.assistant;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * "Save as…" for the app's exports (a conversation as Markdown, a backup): Android's
 * own picker, where the user chooses the folder and the name, then the text is written
 * there. A WebView ignores the browser's download links, so the web code calls this.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "text/plain"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "file.txt"));
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        JSObject answer = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            answer.put("saved", false); // cancelled
            call.resolve(answer);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IllegalStateException("no output stream");
            out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            answer.put("saved", true);
            call.resolve(answer);
        } catch (Exception e) {
            call.reject("Couldn't save the file: " + e.getMessage());
        }
    }
}
