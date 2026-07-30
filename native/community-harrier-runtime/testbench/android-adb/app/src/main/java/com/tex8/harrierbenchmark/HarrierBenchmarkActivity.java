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

import org.pytorch.executorch.EValue;
import org.pytorch.executorch.Module;
import org.pytorch.executorch.Tensor;

import java.io.File;
import java.util.Arrays;
import java.util.Locale;

public final class HarrierBenchmarkActivity extends Activity {
    private static final String TAG = "TEX8_HARRIER_BENCH";
    private static final int MAX_INPUT_TOKENS = 256;
    private static final int EMBEDDING_DIMENSION = 640;
    private static final int[] QUERY_TOKEN_IDS = {
        2, 218875, 236787, 17770, 496, 4325, 2304, 3399, 3927, 7609,
        236764, 33205, 7798, 1237, 20183, 236764, 12714, 236764, 3019,
        236764, 3211, 236764, 4668, 236764, 532, 8207, 26777, 50241,
        107, 7990, 236787, 2961, 93214, 126066, 9561, 5368, 212343,
        1898, 35853, 1
    };

    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        statusView = new TextView(this);
        statusView.setText("Running native Harrier A8W8 benchmark…");
        statusView.setTextSize(18.0f);
        statusView.setPadding(32, 32, 32, 32);
        setContentView(statusView);

        final int warmups = boundedExtra("warmups", 5, 1, 20);
        final int iterations = boundedExtra("iterations", 30, 5, 200);
        new Thread(() -> runBenchmark(warmups, iterations), "harrier-benchmark")
            .start();
    }

    private int boundedExtra(
        String name,
        int defaultValue,
        int minimum,
        int maximum
    ) {
        final int value = getIntent().getIntExtra(name, defaultValue);
        return Math.max(minimum, Math.min(maximum, value));
    }

    private void runBenchmark(int warmups, int iterations) {
        final File model = new File(getFilesDir(), "harrier-v1.pte");
        try {
            if (!model.isFile() || !model.canRead()) {
                throw new IllegalStateException(
                    "Missing readable model at " + model.getAbsolutePath()
                );
            }

            final long[] inputIds = new long[MAX_INPUT_TOKENS];
            final long[] attentionMask = new long[MAX_INPUT_TOKENS];
            for (int index = 0; index < QUERY_TOKEN_IDS.length; index++) {
                inputIds[index] = QUERY_TOKEN_IDS[index];
                attentionMask[index] = 1L;
            }
            final EValue input = EValue.from(
                Tensor.fromBlob(inputIds, new long[] {1L, MAX_INPUT_TOKENS})
            );
            final EValue mask = EValue.from(
                Tensor.fromBlob(attentionMask, new long[] {1L, MAX_INPUT_TOKENS})
            );

            final long loadStartNs = SystemClock.elapsedRealtimeNanos();
            try (Module module = Module.load(
                model.getAbsolutePath(),
                Module.LOAD_MODE_MMAP
            )) {
                module.loadMethod("forward");
                final double loadMs = elapsedMs(loadStartNs);

                float[] lastEmbedding = null;
                for (int index = 0; index < warmups; index++) {
                    lastEmbedding = execute(module, input, mask);
                }

                final double[] durationsMs = new double[iterations];
                final long measurementStartNs =
                    SystemClock.elapsedRealtimeNanos();
                for (int index = 0; index < iterations; index++) {
                    final long startNs = SystemClock.elapsedRealtimeNanos();
                    lastEmbedding = execute(module, input, mask);
                    durationsMs[index] = elapsedMs(startNs);
                }
                final double measurementMs = elapsedMs(measurementStartNs);
                final double norm = requireEmbedding(lastEmbedding);
                Arrays.sort(durationsMs);
                final double meanMs = measurementMs / iterations;
                final double embeddingsPerSecond =
                    iterations * 1000.0 / measurementMs;
                final double minimumMs = durationsMs[0];
                final double medianMs = percentile(durationsMs, 0.50);
                final double p95Ms = percentile(durationsMs, 0.95);
                final double maximumMs =
                    durationsMs[durationsMs.length - 1];

                final String result = String.format(
                    Locale.US,
                    "{\"schemaVersion\":1,\"backend\":\"xnnpack\","
                        + "\"artifact\":\"xnnpack_a8w8\","
                        + "\"runtimeVersion\":\"1.3.1\","
                        + "\"inputTokens\":%d,\"paddedTokens\":%d,"
                        + "\"embeddingDimension\":%d,\"warmups\":%d,"
                        + "\"iterations\":%d,\"loadMs\":%.3f,"
                        + "\"measurementMs\":%.3f,"
                        + "\"embeddingsPerSecond\":%.6f,"
                        + "\"meanMs\":%.3f,\"minimumMs\":%.3f,"
                        + "\"medianMs\":%.3f,\"p95Ms\":%.3f,"
                        + "\"maximumMs\":%.3f,\"outputNorm\":%.9f,"
                        + "\"availableProcessors\":%d}",
                    QUERY_TOKEN_IDS.length,
                    MAX_INPUT_TOKENS,
                    EMBEDDING_DIMENSION,
                    warmups,
                    iterations,
                    loadMs,
                    measurementMs,
                    embeddingsPerSecond,
                    meanMs,
                    minimumMs,
                    medianMs,
                    p95Ms,
                    maximumMs,
                    norm,
                    Runtime.getRuntime().availableProcessors()
                );
                Log.i(TAG, "TEX8_HARRIER_BENCH_RESULT " + result);
                showStatus(
                    String.format(
                        Locale.US,
                        "Accepted\n%.3f embeddings/s\nMedian %.1f ms",
                        embeddingsPerSecond,
                        medianMs
                    )
                );
            }
        } catch (Throwable error) {
            Log.e(TAG, "TEX8_HARRIER_BENCH_FAILURE", error);
            showStatus("Benchmark failed\n" + error.getClass().getSimpleName());
        }
    }

    private static float[] execute(
        Module module,
        EValue input,
        EValue mask
    ) {
        final EValue[] outputs = module.forward(input, mask);
        if (outputs == null || outputs.length != 1 || !outputs[0].isTensor()) {
            throw new IllegalStateException(
                "ExecuTorch returned an invalid output list"
            );
        }
        final float[] embedding =
            outputs[0].toTensor().getDataAsFloatArray();
        requireEmbedding(embedding);
        return embedding;
    }

    private static double requireEmbedding(float[] embedding) {
        if (embedding == null || embedding.length != EMBEDDING_DIMENSION) {
            throw new IllegalStateException(
                "ExecuTorch returned an invalid embedding dimension"
            );
        }
        double squaredNorm = 0.0;
        for (float value : embedding) {
            if (!Float.isFinite(value)) {
                throw new IllegalStateException(
                    "ExecuTorch returned a non-finite embedding"
                );
            }
            squaredNorm += (double) value * value;
        }
        final double norm = Math.sqrt(squaredNorm);
        if (norm < 0.999 || norm > 1.001) {
            throw new IllegalStateException(
                "ExecuTorch returned a non-normalized embedding"
            );
        }
        return norm;
    }

    private static double elapsedMs(long startNs) {
        return (SystemClock.elapsedRealtimeNanos() - startNs) / 1_000_000.0;
    }

    private static double percentile(double[] sortedValues, double fraction) {
        final double position = fraction * (sortedValues.length - 1);
        final int lower = (int) Math.floor(position);
        final int upper = (int) Math.ceil(position);
        if (lower == upper) {
            return sortedValues[lower];
        }
        final double weight = position - lower;
        return sortedValues[lower] * (1.0 - weight)
            + sortedValues[upper] * weight;
    }

    private void showStatus(String status) {
        runOnUiThread(() -> statusView.setText(status));
    }
}
