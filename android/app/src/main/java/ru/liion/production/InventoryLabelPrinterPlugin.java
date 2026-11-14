package ru.liion.production;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;

/** Explicit platform printing of an inert local label. No network, scripts or file access. */
@CapacitorPlugin(name = "InventoryLabelPrinter")
public class InventoryLabelPrinterPlugin extends Plugin {
    private WebView printView;

    @PluginMethod
    public void printLabel(PluginCall call) {
        String html = call.getString("html"), jobName = call.getString("jobName");
        if (html == null || html.length() > 40000 || !html.startsWith("<!doctype html>")
                || jobName == null || !jobName.matches("Storage-(container|location|batch)-[0-9a-f-]{36}")) {
            call.reject("Invalid local label"); return;
        }
        getActivity().runOnUiThread(() -> {
            if (printView != null) { call.reject("A label print dialog is already open"); return; }
            PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            if (manager == null) { call.reject("Printing is unavailable on this device"); return; }
            printView = new WebView(getActivity());
            printView.getSettings().setJavaScriptEnabled(false);
            printView.getSettings().setAllowFileAccess(false);
            printView.getSettings().setAllowContentAccess(false);
            printView.getSettings().setBlockNetworkLoads(true);
            printView.setWebViewClient(new WebViewClient() {
                private boolean opened;
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                @Override public void onPageFinished(WebView view, String url) {
                    if (opened) return; opened = true;
                    try {
                        PrintDocumentAdapter original = view.createPrintDocumentAdapter(jobName);
                        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                            @Override public void onStart() { original.onStart(); }
                            @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, android.os.CancellationSignal cancellation, LayoutResultCallback callback, android.os.Bundle extras) { original.onLayout(oldAttributes, newAttributes, cancellation, callback, extras); }
                            @Override public void onWrite(android.print.PageRange[] pages, android.os.ParcelFileDescriptor destination, android.os.CancellationSignal cancellation, WriteResultCallback callback) { original.onWrite(pages, destination, cancellation, callback); }
                            @Override public void onFinish() { original.onFinish(); view.destroy(); printView = null; }
                        };
                        manager.print(jobName, adapter, new PrintAttributes.Builder().build());
                        JSObject result = new JSObject(); result.put("dialogOpened", true); call.resolve(result);
                    } catch (Exception error) { view.destroy(); printView = null; call.reject("Could not open label printing"); }
                }
            });
            printView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }
    @Override protected void handleOnDestroy() {
        if (printView != null) { printView.destroy(); printView = null; }
    }
}
