/* MFW-Miner
 * Copyright 2026 TEX8
 *
 * This file is part of MFW-Miner and is distributed under GPL-3.0-or-later.
 */

#ifndef XMRIG_JIT_CORPUS_H
#define XMRIG_JIT_CORPUS_H


#include <cstddef>
#include <cstdint>


namespace randomx {


class Program;
struct ProgramConfiguration;


class JitCorpus
{
public:
    static JitCorpus &instance();

    bool open(const char *path, uint64_t limit, const char *requestedVersions, uint32_t v2TweakMask);
    void setCaptureLimit(uint64_t limit);
    void beginReplay(int version, uint64_t iterations, uint64_t sequence);
    void endReplay(int version, uint64_t iterations, uint64_t sequence);
    void close();
    void record(const char *backend, bool light, Program &program, const ProgramConfiguration &config,
                const uint8_t *code, const uint32_t *instructionOffsets);

    bool healthy() const;
    uint64_t count() const;
    const char *error() const;

private:
    JitCorpus();
    ~JitCorpus();
    JitCorpus(const JitCorpus &);
    JitCorpus &operator=(const JitCorpus &);

    struct State;
    State *m_state;
};


} // namespace randomx


namespace xmrig {


class Arguments;
class Process;


bool isJitCorpusRequested(const Arguments &args);
int runJitCorpus(const Process &process);


} // namespace xmrig


#endif // XMRIG_JIT_CORPUS_H
