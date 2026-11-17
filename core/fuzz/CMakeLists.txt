# libFuzzer targets (built with -DTK_FUZZ=ON and clang). See core/README.md.

set(TK_GEN_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../tests/gen)
set(TK_SEEDS_DIR ${CMAKE_BINARY_DIR}/seeds)

foreach(f fuzz_parser fuzz_frame fuzz_clippack)
    add_executable(${f} ${f}.c)
    target_link_libraries(${f} PRIVATE tk_core)
    target_include_directories(${f} PRIVATE ${TK_GEN_DIR})
    target_compile_options(${f} PRIVATE ${TK_WARNINGS})
    target_link_options(${f} PRIVATE -fsanitize=fuzzer)
    # At the top of the build dir, so the CLAUDE.md command ./build/fuzz/fuzz_parser works.
    set_target_properties(${f} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
endforeach()

# Seed corpus, rebuilt from the generated vector header on every build so it always matches
# tests/vectors/. Written to build/<dir>/seeds/{parser,frame}; nothing binary is committed.
add_executable(make_seeds make_seeds.c)
target_link_libraries(make_seeds PRIVATE tk_core)
target_include_directories(make_seeds PRIVATE ${TK_GEN_DIR})
target_compile_options(make_seeds PRIVATE ${TK_WARNINGS})

add_custom_target(fuzz_seeds ALL
    COMMAND ${CMAKE_COMMAND} -E rm -rf ${TK_SEEDS_DIR}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${TK_SEEDS_DIR}/parser ${TK_SEEDS_DIR}/frame ${TK_SEEDS_DIR}/clippack
    COMMAND make_seeds ${TK_SEEDS_DIR}
    DEPENDS make_seeds
    COMMENT "Writing fuzz seed corpus to ${TK_SEEDS_DIR}"
    VERBATIM
)

# Smoke runs so a plain ctest exercises both fuzzers. New inputs go to smoke/, not seeds/.
if(BUILD_TESTING)
    set(TK_SMOKE_DIR ${CMAKE_BINARY_DIR}/smoke)
    file(MAKE_DIRECTORY ${TK_SMOKE_DIR}/parser ${TK_SMOKE_DIR}/frame ${TK_SMOKE_DIR}/clippack)
    add_test(NAME fuzz_parser_smoke
             COMMAND fuzz_parser -runs=20000 -seed=1 -max_len=1300 ${TK_SMOKE_DIR}/parser ${TK_SEEDS_DIR}/parser)
    add_test(NAME fuzz_frame_smoke
             COMMAND fuzz_frame -runs=5000 -seed=1 -max_len=4200 ${TK_SMOKE_DIR}/frame ${TK_SEEDS_DIR}/frame)
    add_test(NAME fuzz_clippack_smoke
             COMMAND fuzz_clippack -runs=20000 -seed=1 -max_len=512 ${TK_SMOKE_DIR}/clippack ${TK_SEEDS_DIR}/clippack)
endif()
