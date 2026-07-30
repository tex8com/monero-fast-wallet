/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
package com.tex8.harrierbenchmark;

import android.app.Activity;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;
import org.pytorch.executorch.EValue;
import org.pytorch.executorch.Module;
import org.pytorch.executorch.Tensor;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;

public final class HarrierSimilarityActivity extends Activity {
    private static final String TAG = "TEX8_HARRIER_SIMILARITY";
    private static final int MAX_INPUT_TOKENS = 256;
    private static final int EMBEDDING_DIMENSION = 640;

    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        statusView = new TextView(this);
        statusView.setText("Embedding synthetic long product fixtures…");
        statusView.setTextSize(18.0f);
        statusView.setPadding(32, 32, 32, 32);
        setContentView(statusView);
        new Thread(this::runSimilarityFixture, "harrier-similarity").start();
    }

    private void runSimilarityFixture() {
        final File model = new File(getFilesDir(), "harrier-v1.pte");
        final File fixture =
            new File(getFilesDir(), "long-product-prepared.json");
        final File output =
            new File(getFilesDir(), "long-product-embeddings.json");
        try {
            if (!model.isFile() || !fixture.isFile()) {
                throw new IllegalStateException(
                    "The verified model or prepared fixture is missing"
                );
            }
            final JSONObject prepared = new JSONObject(
                new String(
                    Files.readAllBytes(fixture.toPath()),
                    StandardCharsets.UTF_8
                )
            );
            final JSONArray cases = prepared.getJSONArray("cases");
            final long loadStartNs = SystemClock.elapsedRealtimeNanos();
            try (Module module = Module.load(
                model.getAbsolutePath(),
                Module.LOAD_MODE_MMAP
            )) {
                module.loadMethod("forward");
                final double loadMs = elapsedMs(loadStartNs);
                if (cases.length() == 0) {
                    throw new IllegalStateException("Fixture has no cases");
                }
                // One unmeasured forward prepares the backend/thread pool.
                final JSONObject first = cases.getJSONObject(0);
                if (!"document".equals(first.getString("kind"))) {
                    throw new IllegalStateException(
                        "Fixture must start with a product"
                    );
                }
                embed(
                    module,
                    first.getJSONArray("embeddingInputs")
                        .getJSONObject(0)
                        .getJSONArray("inputIds")
                );

                final JSONArray products = new JSONArray();
                final JSONArray queries = new JSONArray();
                int measuredEmbeddings = 0;
                final long measurementStartNs =
                    SystemClock.elapsedRealtimeNanos();
                for (int index = 0; index < cases.length(); index++) {
                    final JSONObject item = cases.getJSONObject(index);
                    final JSONObject encoded = new JSONObject();
                    encoded.put("id", item.getString("id"));
                    encoded.put(
                        "fullInputTokens",
                        item.getInt("fullInputTokens")
                    );
                    encoded.put(
                        "retainedInputTokens",
                        item.getInt("retainedInputTokens")
                    );
                    encoded.put(
                        "wasTruncated",
                        item.getBoolean("wasTruncated")
                    );
                    if ("document".equals(item.getString("kind"))) {
                        final JSONArray embeddingInputs =
                            item.getJSONArray("embeddingInputs");
                        final JSONArray chunks = new JSONArray();
                        boolean foundPrimary = false;
                        for (
                            int inputIndex = 0;
                            inputIndex < embeddingInputs.length();
                            inputIndex++
                        ) {
                            final JSONObject embeddingInput =
                                embeddingInputs.getJSONObject(inputIndex);
                            final JSONArray vector = vectorJson(
                                embed(
                                    module,
                                    embeddingInput.getJSONArray("inputIds")
                                )
                            );
                            measuredEmbeddings++;
                            if (embeddingInput.getBoolean("primary")) {
                                if (foundPrimary) {
                                    throw new IllegalStateException(
                                        "Product has multiple primary embeddings"
                                    );
                                }
                                foundPrimary = true;
                                encoded.put("embedding", vector);
                                encoded.put(
                                    "primarySource",
                                    embeddingInput.getString("source")
                                );
                            } else {
                                final JSONObject chunk = new JSONObject();
                                chunk.put(
                                    "source",
                                    embeddingInput.getString("source")
                                );
                                chunk.put(
                                    "ordinal",
                                    embeddingInput.getInt("ordinal")
                                );
                                chunk.put(
                                    "fullInputTokens",
                                    embeddingInput.getInt("fullInputTokens")
                                );
                                chunk.put(
                                    "retainedInputTokens",
                                    embeddingInput.getInt(
                                        "retainedInputTokens"
                                    )
                                );
                                chunk.put(
                                    "wasTruncated",
                                    embeddingInput.getBoolean("wasTruncated")
                                );
                                chunk.put("embedding", vector);
                                chunks.put(chunk);
                            }
                        }
                        if (!foundPrimary) {
                            throw new IllegalStateException(
                                "Product primary embedding is missing"
                            );
                        }
                        encoded.put("embeddingChunks", chunks);
                        encoded.put("title", item.getString("title"));
                        encoded.put(
                            "titleCharacters",
                            item.getString("title").codePointCount(
                                0,
                                item.getString("title").length()
                            )
                        );
                        final JSONArray bullets = item.getJSONArray("bullets");
                        final JSONArray bulletLengths = new JSONArray();
                        for (
                            int bulletIndex = 0;
                            bulletIndex < bullets.length();
                            bulletIndex++
                        ) {
                            final String bullet =
                                bullets.getString(bulletIndex);
                            bulletLengths.put(
                                bullet.codePointCount(0, bullet.length())
                            );
                        }
                        encoded.put("bulletCharacters", bulletLengths);
                        encoded.put(
                            "descriptionCharacters",
                            item.getString("description").codePointCount(
                                0,
                                item.getString("description").length()
                            )
                        );
                        products.put(encoded);
                    } else {
                        encoded.put(
                            "embedding",
                            vectorJson(
                                embed(
                                    module,
                                    item.getJSONArray("inputIds")
                                )
                            )
                        );
                        measuredEmbeddings++;
                        encoded.put(
                            "polarity",
                            item.getString("polarity")
                        );
                        encoded.put(
                            "evaluatedProductId",
                            item.getString("evaluatedProductId")
                        );
                        encoded.put(
                            "expectedTopProductId",
                            item.getString("expectedTopProductId")
                        );
                        queries.put(encoded);
                    }
                }
                final double measurementMs =
                    elapsedMs(measurementStartNs);
                final JSONObject result = new JSONObject();
                result.put("schemaVersion", 1);
                result.put("artifactTarget", "xnnpack_a8w8");
                result.put("runtimeVersion", "1.3.1");
                result.put("embeddingDimension", EMBEDDING_DIMENSION);
                result.put("loadMs", loadMs);
                result.put("measurementMs", measurementMs);
                result.put(
                    "embeddingsPerSecond",
                    measuredEmbeddings * 1000.0 / measurementMs
                );
                result.put("measuredEmbeddings", measuredEmbeddings);
                result.put("products", products);
                result.put("queries", queries);
                Files.write(
                    output.toPath(),
                    result.toString().getBytes(StandardCharsets.UTF_8)
                );
                Log.i(
                    TAG,
                    String.format(
                        Locale.US,
                        "TEX8_HARRIER_SIMILARITY_READY products=%d "
                            + "queries=%d vectors=%d "
                            + "embeddings_per_second=%.6f "
                            + "privacy=no-text-or-vector-logs",
                        products.length(),
                        queries.length(),
                        measuredEmbeddings,
                        measuredEmbeddings * 1000.0 / measurementMs
                    )
                );
                showStatus(
                    String.format(
                        Locale.US,
                        "Embeddings ready\n%d products · %d queries\n%.3f/s",
                        products.length(),
                        queries.length(),
                        measuredEmbeddings * 1000.0 / measurementMs
                    )
                );
            }
        } catch (Throwable error) {
            Log.e(TAG, "TEX8_HARRIER_SIMILARITY_FAILURE", error);
            showStatus(
                "Similarity fixture failed\n"
                    + error.getClass().getSimpleName()
            );
        }
    }

    private static JSONArray vectorJson(float[] embedding) throws Exception {
        final JSONArray vector = new JSONArray();
        for (float value : embedding) {
            vector.put(value);
        }
        return vector;
    }

    private static float[] embed(Module module, JSONArray tokenIds)
        throws Exception {
        if (tokenIds.length() == 0 || tokenIds.length() > MAX_INPUT_TOKENS) {
            throw new IllegalStateException("Invalid prepared token count");
        }
        final long[] inputIds = new long[MAX_INPUT_TOKENS];
        final long[] attentionMask = new long[MAX_INPUT_TOKENS];
        for (int index = 0; index < tokenIds.length(); index++) {
            inputIds[index] = tokenIds.getLong(index);
            attentionMask[index] = 1L;
        }
        final EValue[] outputs = module.forward(
            EValue.from(
                Tensor.fromBlob(
                    inputIds,
                    new long[] {1L, MAX_INPUT_TOKENS}
                )
            ),
            EValue.from(
                Tensor.fromBlob(
                    attentionMask,
                    new long[] {1L, MAX_INPUT_TOKENS}
                )
            )
        );
        if (outputs == null || outputs.length != 1 || !outputs[0].isTensor()) {
            throw new IllegalStateException("Invalid ExecuTorch output");
        }
        final float[] embedding =
            outputs[0].toTensor().getDataAsFloatArray();
        if (embedding.length != EMBEDDING_DIMENSION) {
            throw new IllegalStateException("Invalid embedding dimension");
        }
        double squaredNorm = 0.0;
        for (float value : embedding) {
            if (!Float.isFinite(value)) {
                throw new IllegalStateException("Non-finite embedding");
            }
            squaredNorm += (double) value * value;
        }
        final double norm = Math.sqrt(squaredNorm);
        if (norm < 0.999 || norm > 1.001) {
            throw new IllegalStateException("Non-normalized embedding");
        }
        return embedding;
    }

    private static double elapsedMs(long startNs) {
        return (SystemClock.elapsedRealtimeNanos() - startNs) / 1_000_000.0;
    }

    private void showStatus(String status) {
        runOnUiThread(() -> statusView.setText(status));
    }
}
