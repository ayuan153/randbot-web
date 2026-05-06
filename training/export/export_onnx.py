"""Export trained PyTorch ValueNet to ONNX format for browser inference."""

import os

import numpy as np
import onnx
import onnxruntime as ort
import torch


def export_to_onnx(model_path: str, output_path: str, input_dim: int = 206):
    """Export ValueNet to ONNX and validate output matches PyTorch.

    Args:
        model_path: Path to saved .pt model state dict.
        output_path: Where to write the .onnx file.
        input_dim: Input feature dimension (default 206).
    """
    from train.train_model import ValueNet

    model = ValueNet(input_dim=input_dim)
    model.load_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
    model.eval()

    dummy_input = torch.randn(1, input_dim)
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        input_names=["state"],
        output_names=["win_probability"],
        dynamic_axes={"state": {0: "batch_size"}},
        opset_version=17,
    )

    # Validate ONNX model
    onnx_model = onnx.load(output_path)
    onnx.checker.check_model(onnx_model)

    # Test inference matches PyTorch
    sess = ort.InferenceSession(output_path)
    test_input = np.random.randn(1, input_dim).astype(np.float32)
    onnx_out = sess.run(None, {"state": test_input})[0]

    with torch.no_grad():
        torch_out = model(torch.FloatTensor(test_input)).numpy()

    assert np.allclose(onnx_out, torch_out, atol=1e-5), "ONNX output doesn't match PyTorch!"
    print(f"Exported to {output_path} ({os.path.getsize(output_path) / 1024:.1f} KB)")
    print("Validation passed. Output matches PyTorch within 1e-5.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Export ValueNet to ONNX")
    parser.add_argument("--model", default="models/value-net-v1.pt")
    parser.add_argument("--output", default="models/value-net-v1.onnx")
    args = parser.parse_args()
    export_to_onnx(args.model, args.output)
