set(TK_TESTS
    test_util
    test_crypto
    test_crc32
    test_ata
    test_parser
    test_proto
    test_solana_consts
)

foreach(t ${TK_TESTS})
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE tk_core)
    target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/gen)
    target_compile_options(${t} PRIVATE ${TK_WARNINGS})
    add_test(NAME ${t} COMMAND ${t})
endforeach()
