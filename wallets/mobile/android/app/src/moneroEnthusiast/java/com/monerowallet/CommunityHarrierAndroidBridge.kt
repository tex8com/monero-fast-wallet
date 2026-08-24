/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
package com.monerowallet

import org.pytorch.executorch.EValue
import org.pytorch.executorch.Module
import org.pytorch.executorch.Tensor

/** Android ExecuTorch boundary; React never receives text inputs or embeddings. */
object CommunityHarrierAndroidBridge {
  private const val inputTokens = 256
  private const val embeddingDimension = 640
  private val lock = Any()
  private var module: Module? = null
  private var diagnostic = "Android ExecuTorch is not initialized"

  @JvmStatic
  fun loadVerified(ptePath: String): String? = synchronized(lock) {
    try {
      module?.close()
      val loaded = Module.load(ptePath, Module.LOAD_MODE_MMAP)
      loaded.loadMethod("forward")
      module = loaded
      diagnostic = ""
      null
    } catch (_: Throwable) {
      module = null
      diagnostic = "Android ExecuTorch could not load the verified model"
      diagnostic
    }
  }

  @JvmStatic
  fun forward(inputIds: LongArray, attentionMask: LongArray): FloatArray? = synchronized(lock) {
    if (inputIds.size != inputTokens || attentionMask.size != inputTokens) {
      diagnostic = "Android ExecuTorch input contract is invalid"
      return null
    }
    val loaded = module ?: run {
      diagnostic = "Android ExecuTorch model is not loaded"
      return null
    }
    return try {
      val outputs = loaded.forward(
        EValue.from(Tensor.fromBlob(inputIds, longArrayOf(1L, inputTokens.toLong()))),
        EValue.from(Tensor.fromBlob(attentionMask, longArrayOf(1L, inputTokens.toLong()))),
      )
      val embedding = if (outputs.size == 1 && outputs[0].isTensor) {
        outputs[0].toTensor().dataAsFloatArray
      } else {
        null
      }
      if (embedding == null || embedding.size != embeddingDimension) {
        diagnostic = "Android ExecuTorch output contract is invalid"
        null
      } else {
        diagnostic = ""
        embedding
      }
    } catch (_: Throwable) {
      diagnostic = "Android ExecuTorch inference failed"
      null
    }
  }

  @JvmStatic
  fun lastError(): String = synchronized(lock) { diagnostic }
}
