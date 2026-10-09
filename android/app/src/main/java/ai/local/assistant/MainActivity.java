package ai.local.assistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SaveFilePlugin.class); // "Save as…" for exports
        super.onCreate(savedInstanceState);
    }
}
