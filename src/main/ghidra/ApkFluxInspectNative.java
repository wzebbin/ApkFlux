// Exports read-only Ghidra views for the ApkFlux workbench.
import com.google.gson.GsonBuilder;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;

import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public class ApkFluxInspectNative extends HeadlessScript {
    private static final int FUNCTION_LIMIT = 20_000;
    private static final int INSTRUCTION_LIMIT = 4_000;
    private static final int TEXT_LIMIT = 512 * 1024;

    private record FunctionRow(String name, String address) {}
    private record Library(List<FunctionRow> functions, String language, boolean limited, boolean timedOut) {}
    private record Code(String disassembly, String pseudocode, String pseudocodeError, boolean instructionsLimited) {}

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        Object result;
        if (args.length == 2 && args[1].equals("index")) {
            result = index();
        } else if (args.length == 3 && args[1].equals("function")) {
            result = inspect(args[2]);
        } else {
            throw new IllegalArgumentException("Invalid ApkFlux script arguments");
        }

        monitor.checkCancelled();
        try (Writer output = Files.newBufferedWriter(Path.of(args[0]), StandardCharsets.UTF_8)) {
            new GsonBuilder().serializeNulls().create().toJson(result, output);
        }
    }

    private Library index() throws Exception {
        List<FunctionRow> rows = new ArrayList<>();
        FunctionIterator functions = currentProgram.getFunctionManager().getFunctionsNoStubs(true);
        while (functions.hasNext() && rows.size() < FUNCTION_LIMIT) {
            monitor.checkCancelled();
            Function function = functions.next();
            rows.add(new FunctionRow(limit(function.getName(), 512), function.getEntryPoint().toString()));
        }
        return new Library(rows, currentProgram.getLanguageID().toString(), functions.hasNext(),
            analysisTimeoutOccurred());
    }

    private Code inspect(String addressText) throws Exception {
        Address address = currentProgram.getAddressFactory().getAddress(addressText);
        Function function = address == null ? null : currentProgram.getFunctionManager().getFunctionAt(address);
        if (function == null || function.isExternal()) {
            throw new IllegalArgumentException("No function at the indexed address");
        }

        StringBuilder assembly = new StringBuilder();
        InstructionIterator instructions = currentProgram.getListing().getInstructions(function.getBody(), true);
        int count = 0;
        while (instructions.hasNext() && count < INSTRUCTION_LIMIT && assembly.length() < TEXT_LIMIT - 1024) {
            monitor.checkCancelled();
            Instruction instruction = instructions.next();
            assembly.append(instruction.getAddress()).append("  ").append(limit(instruction.toString(), 980)).append('\n');
            count++;
        }

        DecompInterface decompiler = new DecompInterface();
        String pseudocode = null;
        String detail = null;
        try {
            if (decompiler.openProgram(currentProgram)) {
                DecompileResults result = decompiler.decompileFunction(function, 25, monitor);
                if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
                    String code = result.getDecompiledFunction().getC();
                    pseudocode = code.length() <= TEXT_LIMIT ? code : code.substring(0, TEXT_LIMIT) + "\n/* output truncated */\n";
                } else {
                    detail = result.getErrorMessage();
                }
            } else {
                detail = decompiler.getLastMessage();
            }
        } catch (RuntimeException error) {
            detail = error.getMessage();
        } finally {
            decompiler.dispose();
        }

        if (pseudocode == null && (detail == null || detail.isBlank())) detail = "Decompiler did not return code.";
        return new Code(assembly.toString(), pseudocode, limit(detail, 500), instructions.hasNext());
    }

    private static String limit(String value, int length) {
        return value == null || value.length() <= length ? value : value.substring(0, length);
    }
}
