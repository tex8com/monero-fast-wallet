/* MFW-Miner
 * Copyright 2026 TEX8
 *
 * This file is part of MFW-Miner and is distributed under GPL-3.0-or-later.
 */

#include "crypto/rx/JitCorpus.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>

#include "backend/cpu/Cpu.h"
#include "base/kernel/Process.h"
#include "base/tools/Arguments.h"
#include "base/tools/Buffer.h"
#include "crypto/randomx/instruction.hpp"
#include "crypto/randomx/intrin_portable.h"
#include "crypto/randomx/program.hpp"
#include "crypto/randomx/randomx.h"
#include "crypto/randomx/virtual_machine.hpp"
#include "crypto/rx/RxCache.h"
#include "version.h"

#ifdef XMRIG_OS_APPLE
#   include <os/signpost.h>
#endif


namespace {


static const char *kInstructionNames[] = {
    "IADD_RS", "IADD_M", "ISUB_R", "ISUB_M", "IMUL_R", "IMUL_M",
    "IMULH_R", "IMULH_M", "ISMULH_R", "ISMULH_M", "IMUL_RCP", "INEG_R",
    "IXOR_R", "IXOR_M", "IROR_R", "IROL_R", "ISWAP_R", "FSWAP_R",
    "FADD_R", "FADD_M", "FSUB_R", "FSUB_M", "FSCAL_R", "FMUL_R",
    "FDIV_M", "FSQRT_R", "CBRANCH", "CFROUND", "ISTORE", "NOP"
};


static uint64_t monotonicNs()
{
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}


static uint64_t wallTimeNs()
{
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}


static std::string hex(const void *data, size_t size)
{
    static const char digits[] = "0123456789abcdef";
    const uint8_t *bytes = static_cast<const uint8_t *>(data);
    std::string result;
    result.resize(size * 2);

    for (size_t i = 0; i < size; ++i) {
        result[i * 2] = digits[bytes[i] >> 4];
        result[i * 2 + 1] = digits[bytes[i] & 15];
    }

    return result;
}


static unsigned instructionType(uint8_t opcode)
{
    const uint32_t frequency[] = {
        RandomX_CurrentConfig.RANDOMX_FREQ_IADD_RS,
        RandomX_CurrentConfig.RANDOMX_FREQ_IADD_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISUB_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISUB_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_IMUL_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_IMUL_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_IMULH_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_IMULH_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISMULH_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISMULH_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_IMUL_RCP,
        RandomX_CurrentConfig.RANDOMX_FREQ_INEG_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_IXOR_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_IXOR_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_IROR_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_IROL_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISWAP_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FSWAP_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FADD_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FADD_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_FSUB_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FSUB_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_FSCAL_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FMUL_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_FDIV_M,
        RandomX_CurrentConfig.RANDOMX_FREQ_FSQRT_R,
        RandomX_CurrentConfig.RANDOMX_FREQ_CBRANCH,
        RandomX_CurrentConfig.RANDOMX_FREQ_CFROUND,
        RandomX_CurrentConfig.RANDOMX_FREQ_ISTORE,
        RandomX_CurrentConfig.RANDOMX_FREQ_NOP
    };

    uint32_t upper = 0;
    for (unsigned i = 0; i < sizeof(frequency) / sizeof(frequency[0]); ++i) {
        upper += frequency[i];
        if (opcode < upper) {
            return i;
        }
    }

    return 29;
}


static int randomXVersion()
{
    return RandomX_CurrentConfig.Tweak_V2_CFROUND || RandomX_CurrentConfig.Tweak_V2_AES ||
           RandomX_CurrentConfig.Tweak_V2_PREFETCH || RandomX_CurrentConfig.Tweak_V2_COMMITMENT ? 2 : 1;
}


static const char *optionValue(const xmrig::Arguments &args, const char *name)
{
    const size_t length = strlen(name);
    for (int i = 1; i < args.argc(); ++i) {
        const char *arg = args.argv()[i];
        if (strcmp(arg, name) == 0) {
            return i + 1 < args.argc() ? args.argv()[i + 1] : nullptr;
        }
        if (strncmp(arg, name, length) == 0 && arg[length] == '=') {
            return arg + length + 1;
        }
    }

    return nullptr;
}


static bool parsePrograms(const char *value, uint64_t &programs)
{
    if (!value || !*value) {
        return false;
    }

    char *end = nullptr;
    const unsigned long long parsed = strtoull(value, &end, 10);
    if (*end != '\0' || parsed == 0 || parsed > 1000000ULL) {
        return false;
    }

    programs = static_cast<uint64_t>(parsed);
    return true;
}


static bool parseTweakMask(const char *value, uint32_t &mask)
{
    if (!value || !*value) {
        return false;
    }

    char *end = nullptr;
    const unsigned long parsed = strtoul(value, &end, 0);
    if (*end != '\0' || parsed > 15UL) {
        return false;
    }

    mask = static_cast<uint32_t>(parsed);
    return true;
}


static void fillInput(uint8_t (&input)[32], int version, uint64_t nonce)
{
    memset(input, 0, sizeof(input));
    memcpy(input, "MFWJIT01", 8);
    input[8] = static_cast<uint8_t>(version);
    for (unsigned i = 0; i < 8; ++i) {
        input[16 + i] = static_cast<uint8_t>(nonce >> (i * 8));
    }
}


static void reportFirstDifference(const char *label, const void *jitData, const void *interpreterData, size_t size)
{
    const uint8_t *jitBytes = static_cast<const uint8_t *>(jitData);
    const uint8_t *interpreterBytes = static_cast<const uint8_t *>(interpreterData);
    for (size_t i = 0; i < size; ++i) {
        if (jitBytes[i] != interpreterBytes[i]) {
            fprintf(stderr, "JIT corpus: first %s difference at byte %zu: jit=%02x interpreter=%02x\n",
                    label, i, jitBytes[i], interpreterBytes[i]);
            return;
        }
    }
}


static int runVersion(int version, uint64_t programs, uint64_t replayIterations, uint32_t v2TweakMask)
{
    if (version == 1) {
        randomx_apply_config(RandomX_MoneroConfig);
    }
    else {
        randomx_apply_config(RandomX_MoneroConfigV2);
        RandomX_CurrentConfig.Tweak_V2_CFROUND = (v2TweakMask & 1U) != 0;
        RandomX_CurrentConfig.Tweak_V2_AES = (v2TweakMask & 2U) != 0;
        RandomX_CurrentConfig.Tweak_V2_PREFETCH = (v2TweakMask & 4U) != 0;
        RandomX_CurrentConfig.Tweak_V2_COMMITMENT = (v2TweakMask & 8U) != 0;
    }

    const char *seedText = version == 1 ? "MFW JIT corpus RandomX v1" : "MFW JIT corpus RandomX v2";
    const xmrig::Buffer seed(seedText, seedText + strlen(seedText));
    xmrig::RxCache cache(false, 0);
    if (!cache.get() || !cache.init(seed)) {
        fprintf(stderr, "JIT corpus: failed to initialize RandomX v%d cache\n", version);
        return 2;
    }

    const size_t scratchpadSize = RandomX_CurrentConfig.ScratchpadL3_Size;
    uint8_t *jitScratchpad = static_cast<uint8_t *>(rx_aligned_alloc(scratchpadSize, 64));
    uint8_t *interpreterScratchpad = static_cast<uint8_t *>(rx_aligned_alloc(scratchpadSize, 64));
    if (!jitScratchpad || !interpreterScratchpad) {
        fprintf(stderr, "JIT corpus: failed to allocate scratchpads\n");
        rx_aligned_free(jitScratchpad);
        rx_aligned_free(interpreterScratchpad);
        return 2;
    }

    // Match the native JIT's AES path on the host under test. In particular, the x86 JIT
    // selects its v2 FE-mix template from CPU capabilities, so forcing a software-AES VM on
    // an AES-NI CPU would compare different execution paths instead of checking the emitted
    // program. Hosts without hardware AES still exercise the portable software path.
    const randomx_flags aes = xmrig::Cpu::info()->hasAES() ?
        RANDOMX_FLAG_HARD_AES : RANDOMX_FLAG_DEFAULT;
    const randomx_flags jitFlags = static_cast<randomx_flags>(RANDOMX_FLAG_JIT | aes);
    randomx_vm *jit = randomx_create_vm(jitFlags, cache.get(), nullptr, jitScratchpad, 0);
    randomx_vm *interpreter = randomx_create_vm(aes, cache.get(), nullptr, interpreterScratchpad, 0);
    if (!jit || !interpreter) {
        fprintf(stderr, "JIT corpus: failed to create RandomX v%d differential VMs\n", version);
        if (jit) randomx_destroy_vm(jit);
        if (interpreter) randomx_destroy_vm(interpreter);
        rx_aligned_free(jitScratchpad);
        rx_aligned_free(interpreterScratchpad);
        return 2;
    }

    const uint64_t start = randomx::JitCorpus::instance().count();
    const uint64_t target = start + programs;
    randomx::JitCorpus::instance().setCaptureLimit(target);
    uint64_t hashes = 0;
    int result = 0;

    if (replayIterations > 0) {
        for (uint64_t programIndex = 0; programIndex < programs; ++programIndex) {
            alignas(16) uint64_t jitScratchpadSeed[8] = {
                0x3149544a57464dULL, static_cast<uint64_t>(version), programIndex, 3, 4, 5, 6, 7
            };
            alignas(16) uint64_t interpreterScratchpadSeed[8];
            memcpy(interpreterScratchpadSeed, jitScratchpadSeed, sizeof(jitScratchpadSeed));
            alignas(16) uint64_t jitProgramSeed[8] = {
                0x314d4152474f5250ULL, static_cast<uint64_t>(version), programIndex, 10, 11, 12, 13, 14
            };
            alignas(16) uint64_t interpreterProgramSeed[8];
            memcpy(interpreterProgramSeed, jitProgramSeed, sizeof(jitProgramSeed));

            jit->initScratchpad(jitScratchpadSeed);
            interpreter->initScratchpad(interpreterScratchpadSeed);
            jit->resetRoundingMode();
            jit->run(jitProgramSeed);
            interpreter->resetRoundingMode();
            interpreter->run(interpreterProgramSeed);

            const bool registerMismatch = memcmp(jit->getRegisterFile(), interpreter->getRegisterFile(),
                                                 sizeof(randomx::RegisterFile)) != 0;
            const bool scratchpadMismatch = memcmp(jit->getScratchpad(), interpreter->getScratchpad(),
                                                   scratchpadSize) != 0;
            if (registerMismatch || scratchpadMismatch) {
                fprintf(stderr, "JIT corpus: replay differential mismatch for RandomX v%d program %llu\n",
                        version, static_cast<unsigned long long>(programIndex));
                if (registerMismatch) {
                    reportFirstDifference("register-file", jit->getRegisterFile(), interpreter->getRegisterFile(),
                                          sizeof(randomx::RegisterFile));
                }
                if (scratchpadMismatch) {
                    reportFirstDifference("scratchpad", jit->getScratchpad(), interpreter->getScratchpad(),
                                          scratchpadSize);
                }
                result = 3;
                break;
            }

            const uint64_t sequence = start + programIndex;
            if (randomx::JitCorpus::instance().count() != sequence + 1) {
                fprintf(stderr, "JIT corpus: replay did not capture program %llu exactly once\n",
                        static_cast<unsigned long long>(programIndex));
                result = 2;
                break;
            }

            randomx::JitCorpus::instance().beginReplay(version, replayIterations, sequence);
            if (!jit->replayJit(replayIterations)) {
                fprintf(stderr, "JIT corpus: selected VM does not support replay\n");
                result = 2;
            }
            randomx::JitCorpus::instance().endReplay(version, replayIterations, sequence);
            ++hashes;

            if (result != 0) {
                break;
            }

            // Stable replay deliberately mutates the VM far beyond a normal single-program
            // execution. Recreate both VMs before the next corpus member so no replay-only
            // internal state can contaminate that member's differential oracle.
            if (programIndex + 1 < programs) {
                randomx_destroy_vm(jit);
                randomx_destroy_vm(interpreter);
                jit = randomx_create_vm(jitFlags, cache.get(), nullptr, jitScratchpad, 0);
                interpreter = randomx_create_vm(aes, cache.get(), nullptr, interpreterScratchpad, 0);
                if (!jit || !interpreter) {
                    fprintf(stderr, "JIT corpus: failed to recreate RandomX v%d replay VMs\n", version);
                    if (jit) randomx_destroy_vm(jit);
                    if (interpreter) randomx_destroy_vm(interpreter);
                    jit = nullptr;
                    interpreter = nullptr;
                    result = 2;
                    break;
                }
            }
        }
    }
    else while (randomx::JitCorpus::instance().count() < target) {
        uint8_t input[32];
        uint8_t jitHash[RANDOMX_HASH_SIZE];
        uint8_t interpreterHash[RANDOMX_HASH_SIZE];
        fillInput(input, version, hashes);

        randomx_calculate_hash(jit, input, sizeof(input), jitHash);
        randomx_calculate_hash(interpreter, input, sizeof(input), interpreterHash);
        ++hashes;

        if (memcmp(jitHash, interpreterHash, sizeof(jitHash)) != 0) {
            fprintf(stderr, "JIT corpus: differential mismatch for RandomX v%d input %llu\n",
                    version, static_cast<unsigned long long>(hashes - 1));
            result = 3;
            break;
        }
        if (!randomx::JitCorpus::instance().healthy()) {
            fprintf(stderr, "JIT corpus: output failure: %s\n", randomx::JitCorpus::instance().error());
            result = 2;
            break;
        }
    }

    if (jit) randomx_destroy_vm(jit);
    if (interpreter) randomx_destroy_vm(interpreter);
    rx_aligned_free(jitScratchpad);
    rx_aligned_free(interpreterScratchpad);

    printf("JIT corpus RandomX v%d: %llu programs, %llu differential hashes, %s\n",
           version,
           static_cast<unsigned long long>(randomx::JitCorpus::instance().count() - start),
           static_cast<unsigned long long>(hashes),
           result == 0 ? "PASS" : "FAIL");
    if (result == 0 && replayIterations > 0) {
        printf("JIT corpus RandomX v%d: %llu stable JIT replay iterations across %llu programs completed\n",
               version, static_cast<unsigned long long>(replayIterations * programs),
               static_cast<unsigned long long>(programs));
    }
    return result;
}


} // namespace


struct randomx::JitCorpus::State
{
    mutable std::mutex mutex;
    FILE *file = nullptr;
    uint64_t limit = 0;
    uint64_t captureLimit = 0;
    uint64_t count = 0;
    bool healthy = true;
    std::string error;
#ifdef XMRIG_OS_APPLE
    os_log_t signpostLog = nullptr;
    os_signpost_id_t signpostId = OS_SIGNPOST_ID_INVALID;
#endif
};


randomx::JitCorpus::JitCorpus() : m_state(new State()) {}
randomx::JitCorpus::~JitCorpus() { close(); delete m_state; }


randomx::JitCorpus &randomx::JitCorpus::instance()
{
    static JitCorpus corpus;
    return corpus;
}


bool randomx::JitCorpus::open(const char *path, uint64_t limit, const char *requestedVersions, uint32_t v2TweakMask)
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (m_state->file) {
        return false;
    }

    m_state->file = fopen(path, "wb");
    m_state->limit = limit;
    m_state->captureLimit = 0;
    m_state->count = 0;
    m_state->healthy = m_state->file != nullptr;
    m_state->error = m_state->file ? "" : "cannot open output file";
    if (!m_state->file) {
        return false;
    }

    fprintf(m_state->file,
            "{\"record\":\"manifest\",\"schema\":1,\"tool\":\"MFW JIT corpus\","
            "\"miner\":\"%s\",\"engine\":\"%s\",\"engine_version\":\"%s\","
            "\"engine_commit\":\"%s\",\"versions\":\"%s\",\"program_limit\":%llu,"
            "\"diagnostic_v2_tweak_mask\":%u,"
            "\"monotonic_ns\":%llu,\"wall_time_ns\":%llu,"
            "\"offline\":true,\"differential_reference\":\"RandomX interpreter\"}\n",
            APP_NAME, APP_ENGINE_NAME, APP_ENGINE_VERSION, APP_ENGINE_COMMIT, requestedVersions,
            static_cast<unsigned long long>(limit), v2TweakMask, static_cast<unsigned long long>(monotonicNs()),
            static_cast<unsigned long long>(wallTimeNs()));
    return true;
}


void randomx::JitCorpus::setCaptureLimit(uint64_t limit)
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    m_state->captureLimit = std::min(limit, m_state->limit);
}


void randomx::JitCorpus::beginReplay(int version, uint64_t iterations, uint64_t sequence)
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (m_state->file) {
        fprintf(m_state->file,
                "{\"record\":\"event\",\"event\":\"replay_start\",\"seq\":%llu,\"randomx\":%d,"
                "\"iterations\":%llu,\"monotonic_ns\":%llu,\"wall_time_ns\":%llu}\n",
                static_cast<unsigned long long>(sequence), version, static_cast<unsigned long long>(iterations),
                static_cast<unsigned long long>(monotonicNs()),
                static_cast<unsigned long long>(wallTimeNs()));
        fflush(m_state->file);
    }

#ifdef XMRIG_OS_APPLE
    m_state->signpostLog = os_log_create("com.tex8.mfw-miner", "jit-corpus");
    m_state->signpostId = os_signpost_id_generate(m_state->signpostLog);
    os_signpost_interval_begin(m_state->signpostLog, m_state->signpostId,
                               "MFWRandomXJITReplay", "RandomX v%d seq=%llu iterations=%llu",
                               version, static_cast<unsigned long long>(sequence),
                               static_cast<unsigned long long>(iterations));
#endif
}


void randomx::JitCorpus::endReplay(int version, uint64_t iterations, uint64_t sequence)
{
#ifdef XMRIG_OS_APPLE
    if (m_state->signpostLog && m_state->signpostId != OS_SIGNPOST_ID_INVALID) {
        os_signpost_interval_end(m_state->signpostLog, m_state->signpostId,
                                 "MFWRandomXJITReplay", "RandomX v%d seq=%llu iterations=%llu",
                                 version, static_cast<unsigned long long>(sequence),
                                 static_cast<unsigned long long>(iterations));
    }
#endif

    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (m_state->file) {
        fprintf(m_state->file,
                "{\"record\":\"event\",\"event\":\"replay_end\",\"seq\":%llu,\"randomx\":%d,"
                "\"iterations\":%llu,\"monotonic_ns\":%llu,\"wall_time_ns\":%llu}\n",
                static_cast<unsigned long long>(sequence), version, static_cast<unsigned long long>(iterations),
                static_cast<unsigned long long>(monotonicNs()),
                static_cast<unsigned long long>(wallTimeNs()));
        fflush(m_state->file);
    }
}


void randomx::JitCorpus::close()
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (!m_state->file) {
        return;
    }

    fprintf(m_state->file, "{\"record\":\"summary\",\"programs\":%llu,\"healthy\":%s}\n",
            static_cast<unsigned long long>(m_state->count), m_state->healthy ? "true" : "false");
    if (fclose(m_state->file) != 0) {
        m_state->healthy = false;
        m_state->error = "failed to close output file";
    }
    m_state->file = nullptr;
}


void randomx::JitCorpus::record(const char *backend, bool light, Program &program,
                                const ProgramConfiguration &config, const uint8_t *code,
                                const uint32_t *instructionOffsets)
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    if (!m_state->file || !m_state->healthy || m_state->count >= m_state->captureLimit) {
        return;
    }

    const uint32_t size = program.getSize();
    for (uint32_t i = 0; i < size; ++i) {
        if (instructionOffsets[i + 1] < instructionOffsets[i]) {
            m_state->healthy = false;
            m_state->error = "non-monotonic JIT instruction offsets";
            return;
        }
    }

    std::ostringstream out;
    out << "{\"record\":\"program\",\"seq\":" << m_state->count
        << ",\"monotonic_ns\":" << monotonicNs()
        << ",\"randomx\":" << randomXVersion()
        << ",\"backend\":\"" << backend
        << "\",\"mode\":\"" << (light ? "light" : "fast")
        << "\",\"program_size\":" << size
        << ",\"native_base\":" << reinterpret_cast<uintptr_t>(code)
        << ",\"code_start\":" << instructionOffsets[0]
        << ",\"code_end\":" << instructionOffsets[size]
        << ",\"code_hex\":\""
        << hex(code + instructionOffsets[0], instructionOffsets[size] - instructionOffsets[0])
        << "\",\"read_regs\":[" << config.readReg0 << ',' << config.readReg1 << ','
        << config.readReg2 << ',' << config.readReg3 << "],\"entropy\":[";

    for (unsigned i = 0; i < 16; ++i) {
        if (i) out << ',';
        const uint64_t value = program.getEntropy(i);
        out << '\"' << hex(&value, sizeof(value)) << '\"';
    }
    out << "],\"instructions\":[";

    for (uint32_t i = 0; i < size; ++i) {
        if (i) out << ',';
        const Instruction &instruction = program(i);
        const unsigned type = instructionType(instruction.opcode);
        const uint32_t begin = instructionOffsets[i];
        const uint32_t end = instructionOffsets[i + 1];
        out << "{\"pc\":" << i
            << ",\"type\":\"" << kInstructionNames[type]
            << "\",\"opcode\":" << static_cast<unsigned>(instruction.opcode)
            << ",\"dst\":" << static_cast<unsigned>(instruction.dst)
            << ",\"src\":" << static_cast<unsigned>(instruction.src)
            << ",\"mod\":" << static_cast<unsigned>(instruction.mod)
            << ",\"imm32\":" << instruction.getImm32()
            << ",\"native_offset\":" << begin
            << ",\"native_size\":" << (end - begin)
            << ",\"native_hex\":\"" << hex(code + begin, end - begin) << "\"}";
    }
    out << "]}\n";

    const std::string line = out.str();
    if (fwrite(line.data(), 1, line.size(), m_state->file) != line.size()) {
        m_state->healthy = false;
        m_state->error = "failed to write output file";
        return;
    }
    ++m_state->count;
}


bool randomx::JitCorpus::healthy() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    return m_state->healthy;
}


uint64_t randomx::JitCorpus::count() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    return m_state->count;
}


const char *randomx::JitCorpus::error() const
{
    std::lock_guard<std::mutex> lock(m_state->mutex);
    return m_state->error.c_str();
}


bool xmrig::isJitCorpusRequested(const Arguments &args)
{
    return optionValue(args, "--jit-corpus-profile") != nullptr;
}


int xmrig::runJitCorpus(const Process &process)
{
    const Arguments &args = process.arguments();
    const char *path = optionValue(args, "--jit-corpus-profile");
    const char *versions = optionValue(args, "--jit-corpus-version");
    versions = versions ? versions : "both";

    uint64_t programs = 16;
    const char *programValue = optionValue(args, "--jit-corpus-programs");
    if (programValue && !parsePrograms(programValue, programs)) {
        fprintf(stderr, "JIT corpus: --jit-corpus-programs must be in range 1..1000000\n");
        return 2;
    }
    if (strcmp(versions, "1") != 0 && strcmp(versions, "2") != 0 && strcmp(versions, "both") != 0) {
        fprintf(stderr, "JIT corpus: --jit-corpus-version must be 1, 2, or both\n");
        return 2;
    }

    uint64_t replayIterations = 0;
    const char *replayValue = optionValue(args, "--jit-corpus-replay");
    if (replayValue && !parsePrograms(replayValue, replayIterations)) {
        fprintf(stderr, "JIT corpus: --jit-corpus-replay must be in range 1..1000000\n");
        return 2;
    }
    if (replayIterations > 0 && strcmp(versions, "both") == 0) {
        fprintf(stderr, "JIT corpus: stable replay requires --jit-corpus-version=1 or 2\n");
        return 2;
    }
    if (replayIterations > 0 && !programValue) {
        programs = 1;
    }

    uint32_t v2TweakMask = 15;
    const char *v2MaskValue = optionValue(args, "--jit-corpus-v2-tweak-mask");
    if (v2MaskValue && !parseTweakMask(v2MaskValue, v2TweakMask)) {
        fprintf(stderr, "JIT corpus: --jit-corpus-v2-tweak-mask must be in range 0..15\n");
        return 2;
    }

    const uint64_t versionCount = strcmp(versions, "both") == 0 ? 2 : 1;
    if (!randomx::JitCorpus::instance().open(path, programs * versionCount, versions, v2TweakMask)) {
        fprintf(stderr, "JIT corpus: cannot open output '%s'\n", path);
        return 2;
    }

    printf("MFW JIT corpus: OFFLINE, no pool, no share submission\n");
    int result = 0;
    if (strcmp(versions, "2") != 0) {
        result = runVersion(1, programs, replayIterations, v2TweakMask);
    }
    if (result == 0 && strcmp(versions, "1") != 0) {
        result = runVersion(2, programs, replayIterations, v2TweakMask);
    }

    randomx::JitCorpus::instance().close();
    return result;
}
